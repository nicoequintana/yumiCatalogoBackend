import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { logError } from "../lib/logError.js";
import { esEmailValido } from "../lib/emailValido.js";
import { normalizarDni, esDniValido } from "../lib/dni.js";
import { hashearPassword, motivoPasswordRechazada } from "../lib/passwords.js";
import { reservarSlot } from "../lib/colaBcrypt.js";
import { ORIGENES_REGISTRO, normalizarEmail } from "../lib/cuentasCliente.js";
import { consumirToken } from "../lib/tokensCuenta.js";
import {
  LARGO_MAX_TOKEN,
  MS_PURGA_NO_VERIFICADAS,
  esEmailAdmisible,
  estaFueraDeVentana,
  exigirTextoAcotado,
  marcarDispositivoConocido,
  marcarVerificada,
  responderMotivo,
} from "../lib/cuentaClienteReglas.js";
import { enviarVerificacion, enviarYaTenesCuenta } from "../services/notificacionesCuenta.service.js";

/*
 * Alta y verificación de la cuenta de cliente (spec "Registro local" y
 * "Verificación"). El login, la recuperación y el perfil viven en los otros
 * tres controllers de `/api/cuenta`; lo compartido, en `cuentaClienteReglas.js`.
 */

const MENSAJE_REGISTRO = "Te mandamos un mail para confirmar tu cuenta.";

/**
 * Purga oportunista GLOBAL (spec, paso 5 de "Registro local"): en cada
 * registro se borran TODAS las cuentas no verificadas con más de 24 h, no
 * solo la del email que llegó — no hay cron que lo haga aparte. Nunca lanza:
 * es mantenimiento de fondo y no puede tumbar el registro que lo disparó.
 *
 * Solo las NUNCA verificadas (`verificadaEn` NULL) y sin pedidos: una
 * reasignada por el panel es un cliente real, y una sola fila con órdenes
 * (FK `NoAction` de `Orden`) haría fallar el `deleteMany` ENTERO.
 */
async function purgarNoVerificadasVencidas() {
  try {
    await prisma.cuentaCliente.deleteMany({
      where: {
        emailVerificado: false,
        verificadaEn: null,
        createdAt: { lt: new Date(Date.now() - MS_PURGA_NO_VERIFICADAS) },
        ordenes: { none: {} },
      },
    });
  } catch (err) {
    logError({ mensaje: "No se pudo purgar cuentas no verificadas vencidas", stack: err.stack, causa: err });
  }
}

/**
 * Todo el trabajo de base y el envío de correo, DESPUÉS de responder. Es lo
 * que cierra la enumeración por registro (Amenaza 16): si esto corriera ANTES
 * de `res.json`, el tiempo de respuesta delataría si el email ya existe.
 *
 * El hash va PRIMERO y SIEMPRE, antes de mirar si la cuenta existe, y
 * `liberarSlot` se libera apenas termina — no al final de la función. La
 * cola de `colaBcrypt.js` (capacidad 3, compartida con `/auth/login`) existe
 * para acotar CPU de bcrypt, no para que un Gmail lento o colgado (el envío
 * de abajo puede tardar minutos) le robe slots a los admins tratando de
 * loguearse. Sostener el slot hasta el `await enviarVerificacion` convertiría
 * tres registros concurrentes con SMTP degradado en un 503 para TODO el
 * sistema, login incluido.
 */
async function procesarRegistro({ email, password, nombre, telefono, dni }, liberarSlot) {
  let passwordHash;
  try {
    passwordHash = await hashearPassword(password);
  } finally {
    liberarSlot();
  }

  const existente = await prisma.cuentaCliente.findUnique({ where: { email } });

  if (existente?.emailVerificado) {
    await enviarYaTenesCuenta(existente.email);
  } else if (existente && !estaFueraDeVentana(existente)) {
    // No verificada y todavía dentro de la ventana: reenvía sin pisar nada.
    // `enviarVerificacion` invalida los tokens viejos DESPUÉS de emitir el nuevo.
    await enviarVerificacion(existente);
  } else {
    if (existente) {
      // Vencida: se purga (cascade a sus tokens) y sigue como si "no existiera".
      // `deleteMany` y no `delete`: si la purga global de otra request la
      // borró primero, `delete` lanzaría P2025 y tumbaría este registro. Las
      // guardas van también en el `where` (nunca verificada, sin pedidos): no
      // depender solo del `if` de arriba, que decidió sobre una lectura vieja.
      await prisma.cuentaCliente.deleteMany({ where: { id: existente.id, verificadaEn: null, ordenes: { none: {} } } });
    }
    try {
      const cuenta = await prisma.cuentaCliente.create({
        // Lista blanca campo por campo: un body con `emailVerificado`,
        // `tokenVersion`, `origenRegistro` o `id` NO llega a `data` (Amenaza 8).
        data: { email, passwordHash, origenRegistro: ORIGENES_REGISTRO.LOCAL, nombre, telefono, dni },
      });
      await enviarVerificacion(cuenta);
    } catch (err) {
      // P2002 = alguien más registró el MISMO email entre el `findUnique` de
      // arriba y este `create` (dos pestañas, doble click, un reintento del
      // cliente). Esa otra request ya mandó su propio mail de verificación:
      // esta se descarta en silencio, sin loguear — no es una falla del
      // sistema, es una carrera esperable de una tabla sin lock optimista.
      if (err?.code !== "P2002") throw err;
    }
  }

  await purgarNoVerificadasVencidas();
}

export async function registro(req, res, next) {
  try {
    const emailBruto = req.body?.email;
    const password = req.body?.password;

    if (!esEmailAdmisible(emailBruto) || !esEmailValido(emailBruto)) {
      throw httpError(400, "El email no es válido.");
    }
    const nombre = exigirTextoAcotado(req.body?.nombre, { etiqueta: "El nombre", siVacio: "El nombre es obligatorio." });
    const telefono = exigirTextoAcotado(req.body?.telefono, { etiqueta: "El teléfono", siVacio: "El teléfono es obligatorio." });
    const dni = normalizarDni(req.body?.dni);
    if (!esDniValido(dni)) throw httpError(400, "El DNI debe tener 7 u 8 dígitos.");

    const motivo = motivoPasswordRechazada(password, { email: emailBruto, dni });
    if (motivo) throw httpError(400, motivo);

    const email = normalizarEmail(emailBruto);

    // Se reserva ANTES de responder y ANTES de tocar la base (mismo criterio
    // que `/auth/login`, ver `colaBcrypt.js`): si no hay lugar, el cliente
    // recibe 503 CAPACIDAD en vez del 200. Reservarlo más abajo, recién antes
    // de `hashearPassword` en `procesarRegistro`, dejaría ese 503 escapar
    // DESPUÉS de `res.json` — el propio fire-and-forget que la Amenaza 16
    // exige para no filtrar si el email existe terminaría tragándose la
    // saturación en vez de devolvérsela al cliente.
    //
    // La liberación NO queda acá: se la lleva `procesarRegistro`, que la
    // suelta apenas termina de hashear (no al final de todo su trabajo). Ver
    // su docstring. `liberarSlot` ya es idempotente (`colaBcrypt.js`), pero
    // el `.finally` de abajo es una segunda red de seguridad explícita por si
    // algo revienta ANTES de que `procesarRegistro` llegue a liberarlo.
    const liberarSlot = await reservarSlot();

    res.json({ mensaje: MENSAJE_REGISTRO });

    procesarRegistro({ email, password, nombre, telefono, dni }, liberarSlot)
      .catch((err) => {
        logError({ mensaje: `No se pudo procesar el registro de ${email}`, stack: err.stack, causa: err });
      })
      .finally(() => liberarSlot());
  } catch (err) {
    next(err);
  }
}

const MENSAJE_REENVIO = "Si tenés una cuenta pendiente de confirmar, te mandamos un mail nuevo.";

/**
 * Mismo trato "silencioso" que la rama ya-verificada de `/registro`: ni
 * cuenta inexistente ni ya verificada mandan nada — acá no aplica "olvidé mi
 * contraseña", solo el mail de verificación de una cuenta pendiente.
 *
 * Tampoco la que ya pasó sus 24 h: un reenvío a las 23:59 emitía un token de
 * 24 h más y la cuenta no verificada vivía ~48 h. Esa cuenta se purga; quien
 * la quiera, se registra de nuevo.
 */
async function procesarReenvio(email) {
  const cuenta = await prisma.cuentaCliente.findUnique({ where: { email } });
  if (!cuenta || cuenta.emailVerificado || estaFueraDeVentana(cuenta)) return;
  await enviarVerificacion(cuenta);
}

export async function reenviarVerificacion(req, res, next) {
  try {
    const emailBruto = req.body?.email;

    // Mismo guard que `/registro`, ANTES de responder: un email con forma
    // inválida no arriesga la Amenaza 16 (nunca toca la base ni depende de
    // si esa dirección existe), así que un 400 acá no delata nada.
    if (!esEmailAdmisible(emailBruto) || !esEmailValido(emailBruto)) {
      throw httpError(400, "El email no es válido.");
    }

    const email = normalizarEmail(emailBruto);

    res.json({ mensaje: MENSAJE_REENVIO });

    procesarReenvio(email).catch((err) => {
      logError({ mensaje: `No se pudo procesar el reenvío de verificación de ${email}`, stack: err.stack, causa: err });
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Es POST y no GET a propósito: Outlook Safe Links y varios antivirus
 * prefetchean todo link de un mail — un GET que consumiera el token lo
 * quemaría antes de que la persona lo vea.
 */
export async function verificar(req, res, next) {
  try {
    const tokenClaro = req.body?.token;
    if (typeof tokenClaro !== "string" || !tokenClaro) throw httpError(400, "Falta el token.");
    if (tokenClaro.length > LARGO_MAX_TOKEN) return responderMotivo(res, "INVALIDO");

    const resultado = await consumirToken({ tokenClaro, tipo: "VERIFICACION" });
    if (!resultado.ok) return responderMotivo(res, resultado.motivo);

    // La ventana de 24 h es de la CUENTA, no solo del token: la guarda va en
    // el `where` de la escritura (`marcarVerificada`), no en un `findUnique` +
    // `if`. Una nunca verificada ya fuera de la ventana responde igual que un
    // link vencido y NO se marca verificada.
    const cuentaClienteId = resultado.fila.cuentaClienteId;
    const count = await marcarVerificada(cuentaClienteId);
    if (count === 0) return responderMotivo(res, "VENCIDO");

    await marcarDispositivoConocido(res, cuentaClienteId);

    // Sin token ni cookie de sesión: un link de mail que loguea es una sesión
    // sin contraseña. Entra por login o código.
    res.json({ mensaje: "Tu cuenta está lista. Entrá." });
  } catch (err) {
    next(err);
  }
}
