import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { logError } from "../lib/logError.js";
import { esEmailValido } from "../lib/emailValido.js";
import { normalizarDni, esDniValido } from "../lib/dni.js";
import { hashearPassword, motivoPasswordRechazada } from "../lib/passwords.js";
import { reservarSlot } from "../lib/colaBcrypt.js";
import { LARGO_MAX_TEXTO } from "../lib/limitesTexto.js";
import { ORIGENES_REGISTRO, HORAS_PURGA_NO_VERIFICADAS, normalizarEmail } from "../lib/cuentasCliente.js";
import { invalidarTokensDe } from "../lib/tokensCuenta.js";
import { enviarVerificacion, enviarYaTenesCuenta } from "../services/notificacionesCuenta.service.js";

const MENSAJE_REGISTRO = "Te mandamos un mail para confirmar tu cuenta.";
/** Límite del índice UNIQUE de `CuentaCliente.email` (1700 bytes): más largo revienta el insert como 500. */
const LARGO_MAX_EMAIL = 254;
const MS_PURGA_NO_VERIFICADAS = HORAS_PURGA_NO_VERIFICADAS * 60 * 60 * 1000;

/**
 * Purga oportunista GLOBAL (spec, paso 5 de "Registro local"): en cada
 * registro se borran TODAS las cuentas no verificadas con más de 24 h, no
 * solo la del email que llegó — no hay cron que lo haga aparte. Nunca lanza:
 * es mantenimiento de fondo y no puede tumbar el registro que lo disparó.
 */
async function purgarNoVerificadasVencidas() {
  try {
    await prisma.cuentaCliente.deleteMany({
      where: { emailVerificado: false, createdAt: { lt: new Date(Date.now() - MS_PURGA_NO_VERIFICADAS) } },
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
  } else if (existente && Date.now() - existente.createdAt.getTime() <= MS_PURGA_NO_VERIFICADAS) {
    // No verificada y todavía dentro de la ventana: reenvía sin pisar nada.
    await invalidarTokensDe(existente.id, "VERIFICACION");
    await enviarVerificacion(existente);
  } else {
    if (existente) {
      // Vencida: se purga (cascade a sus tokens) y sigue como si "no existiera".
      await prisma.cuentaCliente.delete({ where: { id: existente.id } });
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
    const nombre = typeof req.body?.nombre === "string" ? req.body.nombre.trim() : "";
    const telefono = typeof req.body?.telefono === "string" ? req.body.telefono.trim() : "";
    const dni = normalizarDni(req.body?.dni);

    // `typeof === "string"` antes que nada: un email/password que no son
    // string (número, array, objeto) no pueden llegar a bcrypt ni a
    // `normalizarEmail` sin explotar o mentir sobre su forma.
    if (typeof emailBruto !== "string" || emailBruto.length > LARGO_MAX_EMAIL || !esEmailValido(emailBruto)) {
      throw httpError(400, "El email no es válido.");
    }
    if (!nombre) throw httpError(400, "El nombre es obligatorio.");
    if (nombre.length > LARGO_MAX_TEXTO) throw httpError(400, `El nombre no puede superar los ${LARGO_MAX_TEXTO} caracteres.`);
    if (!telefono) throw httpError(400, "El teléfono es obligatorio.");
    if (telefono.length > LARGO_MAX_TEXTO) {
      throw httpError(400, `El teléfono no puede superar los ${LARGO_MAX_TEXTO} caracteres.`);
    }
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
