import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { logAudit } from "../lib/logAudit.js";
import { logError } from "../lib/logError.js";
import { esEmailValido } from "../lib/emailValido.js";
import { normalizarEmail } from "../lib/cuentasCliente.js";
import { enviarVerificacion } from "../services/notificacionesCuenta.service.js";

/** Límite del índice UNIQUE de `CuentaCliente.email` (mismo valor que `cuenta.controller.js`). */
const LARGO_MAX_EMAIL = 254;

/**
 * Reasignación OPERADA del email de una cuenta de cliente, desde el panel
 * (spec, "Camino operado"). El operador verificó la identidad contra el
 * historial de pedidos, fuera de este endpoint.
 *
 * - NO marca `emailVerificado`: queda en `false` hasta que la persona haga
 *   click en el link que llega a la dirección NUEVA — el admin no probó ese
 *   buzón. `verificadaEn` NO se toca: sigue diciendo que es una cuenta real,
 *   y por eso la regla de las 24 h y la purga no la alcanzan.
 * - `tokenVersion` +1 cierra todas las sesiones abiertas.
 * - En la MISMA transacción se invalidan los tokens vivos (fueron al buzón
 *   viejo: un RESET pendiente le devolvería la cuenta a quien lo tenga) y se
 *   borra la `IdentidadGoogle` (el login por `sub` seguiría entrando por la
 *   dirección vieja; mismo criterio que `confirmarEmail`).
 * - El mail sale con `enviarVerificacion(cuenta)`, que emite su propio token
 *   (ruling E: emitir acá dejaría una fila VERIFICACION duplicada).
 */
export async function reasignarEmail(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Cuenta no encontrada.");

    const emailBruto = req.body?.emailNuevo;
    if (typeof emailBruto !== "string" || emailBruto.length > LARGO_MAX_EMAIL || !esEmailValido(emailBruto)) {
      throw httpError(400, "El email nuevo no es válido.");
    }
    const emailNuevo = normalizarEmail(emailBruto);

    const anterior = await prisma.cuentaCliente.findUnique({ where: { id } });
    if (!anterior) throw httpError(404, "Cuenta no encontrada.");
    if (anterior.email === emailNuevo) throw httpError(400, "Ese ya es el email de la cuenta.");

    let actualizada;
    try {
      actualizada = await prisma.$transaction(async (tx) => {
        const cuenta = await tx.cuentaCliente.update({
          where: { id },
          data: { email: emailNuevo, emailVerificado: false, tokenVersion: { increment: 1 } },
        });
        await tx.tokenCuenta.updateMany({ where: { cuentaClienteId: id, usadoEn: null }, data: { usadoEn: new Date() } });
        await tx.identidadGoogle.deleteMany({ where: { cuentaClienteId: id } });
        return cuenta;
      });
    } catch (err) {
      if (err?.code === "P2002") throw httpError(409, "Ese email ya está en uso por otra cuenta.");
      if (err?.code === "P2025") throw httpError(404, "Cuenta no encontrada.");
      throw err;
    }

    // Solo emails: nunca `passwordHash` ni la fila entera (invariante de AuditLog).
    logAudit(req, {
      accion: "REASIGNAR_EMAIL",
      entidad: "CuentaCliente",
      entidadId: id,
      detalle: { emailAnterior: anterior.email, emailNuevo },
    });

    // `.catch` aunque el sender atrape lo suyo: un rechazo sin manejar en el
    // camino del mail ya tumbó el proceso una vez.
    enviarVerificacion(actualizada).catch((err) => {
      logError({ mensaje: `No se pudo enviar la verificación de la cuenta ${id}`, stack: err.stack, causa: err });
    });

    res.json({ ok: true, email: emailNuevo });
  } catch (err) {
    next(err);
  }
}
