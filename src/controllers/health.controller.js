import { prisma } from "../lib/prisma.js";

/**
 * Cuánto se espera a la base antes de declararla inalcanzable.
 *
 * Corto A PROPÓSITO: este endpoint lo consulta el orquestador cada pocos
 * segundos, así que no puede quedarse colgado esperando. Una base sana contesta
 * un `SELECT 1` en milisegundos; si tarda más de dos segundos, para lo que este
 * servicio necesita ya está caída aunque el socket siga abierto.
 */
const TIMEOUT_MS = 2000;

/**
 * Health check del servicio.
 *
 * POR QUÉ CONSULTA LA BASE. Antes respondía `{ ok: true }` sin tocar nada, y
 * eso volvía el chequeo inútil justo en el escenario que existe para detectar:
 * un contenedor que perdió la conexión a SQL Server pasaba el health check de
 * EasyPanel y se quedaba en rotación devolviendo 500 a todos los visitantes.
 * "El proceso de Node está vivo" no es lo mismo que "el servicio puede
 * atender", y lo único que separa las dos cosas es la base.
 *
 * Se combina además con el fail-open deliberado de `sesionRevocada`
 * (`auth.middleware.js`): con la base caída, ese fail-open deja pasar tokens de
 * usuarios ya borrados. Que el contenedor salga de rotación acota esa ventana.
 *
 * NO FILTRA EL ERROR. El motivo real del fallo (host, puerto, usuario del
 * connection string) se queda en el log del servidor. Este endpoint es público
 * y sin auth: emitir el mensaje de Prisma acá le regalaría a cualquiera la
 * topología interna de la base.
 */
export async function estado(_req, res) {
  try {
    // `Promise.race` y no el `timeout` de Prisma: una base COLGADA —que no
    // rechaza, simplemente no contesta— dejaría la request esperando para
    // siempre, y el orquestador leería eso como caída del contenedor entero en
    // vez de como base inalcanzable. Son dos diagnósticos distintos.
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, rechazar) =>
        setTimeout(() => rechazar(new Error("timeout")), TIMEOUT_MS).unref?.(),
      ),
    ]);
    res.json({ ok: true, db: "ok" });
  } catch {
    res.status(503).json({ ok: false, db: "unreachable" });
  }
}
