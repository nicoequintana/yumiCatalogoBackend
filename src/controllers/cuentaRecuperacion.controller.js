import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { logError } from "../lib/logError.js";
import { hashearPassword, motivoPasswordRechazada } from "../lib/passwords.js";
import { reservarSlot } from "../lib/colaBcrypt.js";
import { TIPOS_TOKEN, normalizarEmail } from "../lib/cuentasCliente.js";
import {
  consumirToken,
  emitirToken,
  hashDeToken,
  invalidarTokensDe,
  revocarTokensPendientes,
} from "../lib/tokensCuenta.js";
import {
  LARGO_MAX_TOKEN,
  esEmailAdmisible,
  estaFueraDeVentana,
  marcarDispositivoConocido,
  marcarVerificada,
  responderMotivo,
} from "../lib/cuentaClienteReglas.js";
import { enviarReset } from "../services/notificacionesCuenta.service.js";

/*
 * Recuperación (spec "Recuperación — `POST /cuenta/olvide` + `POST
 * /cuenta/restablecer`"). Es también la puerta del bloqueo por cuenta
 * (Amenaza 19) y de un registro hecho con un email ajeno (Amenaza 21).
 */

const MENSAJE_OLVIDE = "Si hay una cuenta con ese email, te mandamos las instrucciones.";

/**
 * Corre DESPUÉS de responder y nunca decide la respuesta. Una no verificada
 * fuera de su ventana de 24 h es inexistente (mismo criterio que `login`): un
 * RESET le daría otra hora de vida a una cuenta que la purga ya tendría que
 * haber borrado. Una de Google sin contraseña SÍ recibe el link: el spec dice
 * que así adquiere contraseña.
 *
 * Se emite el nuevo y RECIÉN DESPUÉS se invalidan los anteriores a él (`anterioresA`):
 * invalidar primero deja a la cuenta sin ningún link válido si la emisión
 * falla (mismo orden que `enviarVerificacion`).
 */
async function procesarOlvide(email) {
  const cuenta = await prisma.cuentaCliente.findUnique({ where: { email } });
  if (!cuenta || (!cuenta.emailVerificado && estaFueraDeVentana(cuenta))) return;
  const { tokenClaro, expiraEn, id } = await emitirToken({ cuentaClienteId: cuenta.id, tipo: TIPOS_TOKEN.RESET });
  await invalidarTokensDe(cuenta.id, TIPOS_TOKEN.RESET, { anterioresA: id });
  // `enviarReset` reintenta adentro (hasta ~10 s): por eso nada de esto puede
  // correr antes de `res.json`.
  await enviarReset(cuenta, { tokenClaro, expiraEn });
}

/**
 * SIEMPRE el mismo 200 (Amenaza 16): exista o no la cuenta, esté verificada,
 * sea de Google o una no verificada vencida — y también con un email que no
 * es string o pasa de 254, que ni llega a la base. El tiempo tampoco delata:
 * la consulta y el envío corren después de responder.
 */
export async function olvide(req, res, next) {
  try {
    const emailBruto = req.body?.email;
    const email = esEmailAdmisible(emailBruto) ? normalizarEmail(emailBruto) : "";

    res.json({ mensaje: MENSAJE_OLVIDE });

    if (!email) return;
    procesarOlvide(email).catch((err) => {
      logError({ mensaje: `No se pudo procesar el pedido de reseteo de ${email}`, stack: err.stack, causa: err });
    });
  } catch (err) {
    next(err);
  }
}

/**
 * El orden es lo que evita el estado a medias "link quemado, contraseña sin
 * cambiar":
 *
 * 1. Lectura de solo lectura del token para saber de qué cuenta es. NO decide:
 *    si no está vivo, el motivo lo clasifica `consumirToken` (que con un token
 *    no vivo no escribe nada).
 * 2. Validación de la clave nueva contra el email/DNI de la cuenta y el hash,
 *    ANTES de consumir: una clave rechazada (400) o la cola de bcrypt llena
 *    (503) dejan el link intacto para reintentar.
 * 3. Consumo guardado (`tipo: RESET` en el `where`: un VERIFICACION no sirve),
 *    que es la ÚNICA decisión: si otro request lo consumió entre 1 y 3, este
 *    ve USADO y no escribe.
 * 4. Una sola escritura con la ventana de 24 h en el `where` (una no
 *    verificada vencida no se revive, aunque el reseteo pruebe el buzón).
 *
 * Queda una sola ventana a medias — consumo OK y la escritura falla por un
 * error de la base —; `consumirToken` usa su propio cliente y no entra en una
 * transacción. El usuario pide otro link.
 *
 * El slot de bcrypt cubre SOLO el hash (ruling B); solo un token vivo llega a
 * pagar bcrypt. NO devuelve sesión: un link de mail que loguea es una sesión
 * sin contraseña. Sí setea `dispositivo_cliente`: probó el buzón (spec).
 */
export async function restablecer(req, res, next) {
  try {
    const { token, password } = req.body ?? {};
    if (typeof token !== "string" || !token || typeof password !== "string") throw httpError(400, "Faltan datos.");
    if (token.length > LARGO_MAX_TOKEN) return responderMotivo(res, "INVALIDO");

    const vista = await prisma.tokenCuenta.findUnique({ where: { tokenHash: hashDeToken(token) } });
    const viva = vista && vista.tipo === TIPOS_TOKEN.RESET && !vista.usadoEn && vista.expiraEn > new Date();
    if (!viva) {
      const clasificacion = await consumirToken({ tokenClaro: token, tipo: TIPOS_TOKEN.RESET });
      return responderMotivo(res, clasificacion.ok ? "INVALIDO" : clasificacion.motivo);
    }

    const cuenta = await prisma.cuentaCliente.findUnique({ where: { id: vista.cuentaClienteId } });
    if (!cuenta || (!cuenta.emailVerificado && estaFueraDeVentana(cuenta))) return responderMotivo(res, "INVALIDO");

    const motivo = motivoPasswordRechazada(password, { email: cuenta.email, dni: cuenta.dni });
    if (motivo) throw httpError(400, motivo);

    const liberarSlot = await reservarSlot();
    let passwordHash;
    try {
      passwordHash = await hashearPassword(password);
    } finally {
      liberarSlot();
    }

    const resultado = await consumirToken({ tokenClaro: token, tipo: TIPOS_TOKEN.RESET });
    if (!resultado.ok) return responderMotivo(res, resultado.motivo);

    const cuentaClienteId = resultado.fila.cuentaClienteId;
    // `tokenVersion` +1 cierra TODAS las sesiones; el contador y el bloqueo
    // vuelven a cero en la misma escritura (el reseteo desbloquea, Amenaza 19).
    // `marcarVerificada` pone `emailVerificado` y, si es la primera vez, `verificadaEn`.
    const count = await marcarVerificada(cuentaClienteId, {
      passwordHash,
      tokenVersion: { increment: 1 },
      intentosFallidos: 0,
      bloqueadoHasta: null,
    });
    if (count === 0) return responderMotivo(res, "INVALIDO");
    // Mismo criterio que `cambiarPassword`: un CAMBIO_EMAIL o un código
    // pendiente no sobreviven al reseteo (el RESET usado ya quedó consumido).
    await revocarTokensPendientes(prisma, cuentaClienteId, [TIPOS_TOKEN.CAMBIO_EMAIL, TIPOS_TOKEN.CODIGO_ACCESO]);

    await marcarDispositivoConocido(res, cuentaClienteId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
