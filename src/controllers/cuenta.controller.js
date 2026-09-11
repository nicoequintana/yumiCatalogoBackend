import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { logError } from "../lib/logError.js";
import { esEmailValido } from "../lib/emailValido.js";
import { normalizarDni, esDniValido } from "../lib/dni.js";
import { hashearPassword, motivoPasswordRechazada } from "../lib/passwords.js";
import { reservarSlot } from "../lib/colaBcrypt.js";
import { ORIGENES_REGISTRO, HORAS_PURGA_NO_VERIFICADAS, normalizarEmail } from "../lib/cuentasCliente.js";
import { invalidarTokensDe } from "../lib/tokensCuenta.js";
import { enviarVerificacion, enviarYaTenesCuenta } from "../services/notificacionesCuenta.service.js";

const MENSAJE_REGISTRO = "Te mandamos un mail para confirmar tu cuenta.";
/** Límite del índice UNIQUE de `CuentaCliente.email` (1700 bytes): más largo revienta el insert como 500. */
const LARGO_MAX_EMAIL = 254;

/**
 * Todo el trabajo de base y el envío de correo, DESPUÉS de responder. Es lo
 * que cierra la enumeración por registro (Amenaza 16): si esto corriera ANTES
 * de `res.json`, el tiempo de respuesta delataría si el email ya existe.
 */
async function procesarRegistro({ email, password, nombre, telefono, dni }) {
  const existente = await prisma.cuentaCliente.findUnique({ where: { email } });

  if (existente?.emailVerificado) {
    await enviarYaTenesCuenta(existente.email);
    return;
  }

  if (existente) {
    const vencida = Date.now() - existente.createdAt.getTime() > HORAS_PURGA_NO_VERIFICADAS * 60 * 60 * 1000;
    if (vencida) {
      // Se purga (cascade a sus tokens) y sigue como si "no existiera".
      await prisma.cuentaCliente.delete({ where: { id: existente.id } });
    } else {
      await invalidarTokensDe(existente.id, "VERIFICACION");
      await enviarVerificacion(existente);
      return;
    }
  }

  const passwordHash = await hashearPassword(password);
  const cuenta = await prisma.cuentaCliente.create({
    // Lista blanca campo por campo: un body con `emailVerificado`,
    // `tokenVersion`, `origenRegistro` o `id` NO llega a `data` (Amenaza 8).
    data: { email, passwordHash, origenRegistro: ORIGENES_REGISTRO.LOCAL, nombre, telefono, dni },
  });
  await enviarVerificacion(cuenta);
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
    if (!telefono) throw httpError(400, "El teléfono es obligatorio.");
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
    const liberarSlot = await reservarSlot();

    res.json({ mensaje: MENSAJE_REGISTRO });

    procesarRegistro({ email, password, nombre, telefono, dni })
      .catch((err) => {
        logError({ mensaje: `No se pudo procesar el registro de ${email}`, stack: err.stack, causa: err });
      })
      .finally(() => liberarSlot());
  } catch (err) {
    next(err);
  }
}
