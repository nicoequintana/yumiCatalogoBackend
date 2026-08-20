import { prisma } from "./prisma.js";

/**
 * Best-effort technical error logger — persists to the `ErrorLog` table.
 *
 * Intentionally never throws: logging a failure must never break the HTTP
 * response the client already got (or is about to get). Callers use this
 * fire-and-forget (not awaited) so the response never waits on it. If the
 * insert itself fails, we fall back to `console.error` purely as a trace of
 * last resort — never as the primary path.
 *
 * @param {object} params
 * @param {string} params.mensaje
 * @param {string} [params.stack]
 * @param {string} [params.ruta]
 * @param {string} [params.metodo]
 * @param {number} [params.status]
 * @returns {Promise<void>}
 */
export async function logError({ mensaje, stack, ruta, metodo, status }) {
  try {
    await prisma.errorLog.create({
      data: { mensaje, stack, ruta, metodo, status },
    });
  } catch (err) {
    console.error("logError: no se pudo persistir el ErrorLog:", err);
  }
}
