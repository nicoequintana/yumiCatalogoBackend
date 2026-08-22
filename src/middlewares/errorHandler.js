import { logError } from "../lib/logError.js";
import { MAX_FOTOS, MAX_VIDEOS } from "../lib/limitesMedios.js";

/**
 * Manejador central de errores de Express — la ÚNICA respuesta de error del
 * backend.
 *
 * Vive en su propio módulo (y no inline en `server.js`) por una razón concreta
 * de testing: cada `buildApp()` de la suite montaba a mano un handler mínimo
 * (`res.status(err.status ?? 500).json({ error: err.message })`) que no
 * enmascaraba el 500 ni mapeaba nada. Con eso, un test podía pasar afirmando un
 * cuerpo que en producción el cliente nunca recibiría, y las ramas de
 * `MulterError`/`P2002`/`P2003` no tenían NINGUNA cobertura. Los tests montan
 * este mismo handler; si acá cambia el contrato, los tests lo ven.
 *
 * Contrato de respuesta:
 * - `err.status` presente → ese código y `err.message` tal cual al cliente.
 * - Sin `status` → 500 con mensaje genérico. **Nunca se filtra el mensaje real
 *   de un 500**: puede contener nombres de tablas, rutas del filesystem o
 *   fragmentos de query. El detalle completo queda en `ErrorLog`.
 */

/**
 * Traduce un `MulterError` a mensaje para el admin.
 *
 * @param {{ code: string, field?: string }} err
 * @returns {string}
 */
export function mapMulterError(err) {
  if (err.code === "LIMIT_FILE_SIZE") return "El archivo supera el tamaño máximo permitido.";
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    // multer reutiliza este código tanto para un nombre de campo genuinamente
    // desconocido como para haber excedido el `maxCount` del campo — `err.field`
    // los distingue.
    if (err.field === "fotos") return `Se permiten máximo ${MAX_FOTOS} fotos por producto.`;
    if (err.field === "video") return `Se permite máximo ${MAX_VIDEOS} video por producto.`;
    return "Campo de archivo inesperado.";
  }
  return "Error al procesar el archivo subido.";
}

/**
 * Decide status y mensaje al cliente según el tipo de error.
 *
 * @param {unknown} err
 * @param {string} [metodo] método HTTP del request que falló (desambigua P2003)
 * @returns {{ status: number, mensaje: string }}
 */
function clasificarError(err, metodo) {
  if (err?.name === "MulterError") {
    return {
      status: err.code === "LIMIT_FILE_SIZE" ? 413 : 400,
      mensaje: mapMulterError(err),
    };
  }

  // P2000 = valor más largo que su columna. Los campos que el cliente arma
  // libremente (headers, URL) ya se recortan en origen (`lib/limitesTexto.js`),
  // así que esto es la red de seguridad para cualquier columna acotada que
  // todavía reciba texto sin recortar — un dato inválido del cliente es un
  // 400, nunca un 500 opaco con spam en ErrorLog.
  if (err?.code === "P2000") {
    return { status: 400, mensaje: "Uno de los valores enviados es demasiado largo." };
  }

  // P2002 = violación de constraint único.
  if (err?.code === "P2002") {
    const campo = Array.isArray(err.meta?.target) ? err.meta.target[0] : err.meta?.target;
    return { status: 400, mensaje: `Ya existe un registro con ese ${campo ?? "valor"}.` };
  }

  // P2003 = violación de clave foránea. El pre-chequeo de cada controller
  // (ver `productsController.eliminar` y `categoriasController.eliminar`) es
  // la defensa principal y da un mensaje puntual; esto es la red de
  // seguridad para cualquier relación que todavía no lo tenga, para que al
  // admin no le llegue un 500 opaco.
  //
  // El mensaje distingue por método HTTP: la MISMA violación de FK salta al
  // borrar una fila referenciada (DELETE) y al insertar/actualizar apuntando a
  // un id inexistente (ej. `POST /api/eventos` con un productId de fantasía).
  // Sugerir "ocultalo en vez de borrarlo" en un INSERT era absurdo.
  if (err?.code === "P2003") {
    if (metodo === "DELETE") {
      return {
        status: 400,
        mensaje: "No se puede eliminar: otros registros dependen de este. Ocultalo en vez de borrarlo.",
      };
    }
    return { status: 400, mensaje: "Alguno de los datos hace referencia a un registro que no existe." };
  }

  const status = err?.status ?? 500;
  return { status, mensaje: status === 500 ? "Error interno del servidor." : err.message };
}

// eslint-disable-next-line no-unused-vars
export function manejadorDeErrores(err, req, res, _next) {
  const { status, mensaje } = clasificarError(err, req.method);

  // Solo los 500 van a la consola. Antes se imprimía SIEMPRE, así que cada bot
  // pegándole a una ruta inexistente o cada validación de formulario rechazada
  // dejaba un stack completo en los logs del contenedor y enterraba las fallas
  // que sí importan.
  if (status >= 500) console.error(err);

  // Fire-and-forget: la respuesta no espera al insert del log.
  logError({
    mensaje: err?.message,
    stack: err?.stack,
    causa: err?.cause,
    ruta: req.originalUrl,
    metodo: req.method,
    status,
  });

  res.status(status).json({ error: mensaje });
}
