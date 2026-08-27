import { v2 as cloudinary } from "cloudinary";

let configurado = false;

/**
 * Lazily configures the Cloudinary SDK from env vars, mirroring
 * googleDrive.service.js's lazy-client pattern. Credentials come from a
 * Cloudinary account the user already owns (design decision: no
 * account-creation step in this migration).
 */
function configurar() {
  if (configurado) return;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET deben estar configuradas en el entorno.",
    );
  }

  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  configurado = true;
}

/**
 * Uploads a file buffer to Cloudinary. Videos MUST pass
 * `resourceType: "video"` explicitly — Cloudinary's SDK defaults to
 * `"image"` when unset, which silently mis-processes (or fails to later
 * delete) a video asset.
 *
 * `folder` groups a product's media together (e.g. `productos/42-collar`),
 * mirroring Drive's old per-product subfolder — passed straight through to
 * the Upload API's `folder` param, which both places the asset there and
 * prefixes it onto the returned `public_id`. Omit it to upload to the
 * account's root (used by nothing today, kept optional for flexibility).
 *
 * @param {Buffer} buffer - raw file bytes
 * @param {"image"|"video"} resourceType
 * @param {string} [folder]
 * @returns {Promise<{ cloudinaryPublicId: string, cloudinaryResourceType: string, url: string }>}
 */
export function subirArchivo(buffer, resourceType, folder) {
  configurar();

  const opciones = { resource_type: resourceType };
  if (folder) opciones.folder = folder;

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(opciones, (error, result) => {
      if (error) {
        // El SDK rechaza con un OBJETO PLANO ({message, http_code}), no con un
        // Error: sin stack en el ErrorLog y el handler global cae al 500
        // genérico "Error interno del servidor" — doble mentira para el
        // operador, visto en vivo el 2026-08-20 con un upload estancado
        // ({message: "Request Timeout", http_code: 499}, el timeout de
        // inactividad de 60s del SDK). Una subida que falla contra un servicio
        // externo es un problema de gateway, reintentable: 502 con mensaje
        // claro, y un Error real para que el log tenga stack.
        const err = new Error(
          `La subida a Cloudinary falló (${error.message ?? "sin detalle"}). Suele ser un problema transitorio de conexión: probá de nuevo.`,
        );
        err.status = 502;
        err.cause = error;
        return reject(err);
      }
      resolve({
        cloudinaryPublicId: result.public_id,
        cloudinaryResourceType: result.resource_type,
        url: result.secure_url,
      });
    });
    uploadStream.end(buffer);
  });
}

/**
 * Deletes a Cloudinary asset by public id. Unlike Drive (which throws on a
 * missing file, handled by catching a 404), Cloudinary's destroy() resolves
 * successfully with `{ result: "not found" }` for an already-gone asset —
 * that case is treated as a no-op here too, keeping the same "cleanup never
 * throws for already-gone files" contract callers already rely on.
 *
 * @param {string} publicId
 * @param {"image"|"video"} resourceType
 * @returns {Promise<void>}
 */
export async function eliminarArchivo(publicId, resourceType) {
  configurar();

  const resultado = await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  if (resultado.result !== "ok" && resultado.result !== "not found") {
    throw new Error(`No se pudo eliminar el archivo de Cloudinary: ${JSON.stringify(resultado)}`);
  }
}

/**
 * Deletes a Cloudinary folder. The Admin API's `delete_folder` only succeeds
 * on an empty folder — callers must delete every asset inside it first (the
 * product's fotos/video via `eliminarArchivo`). A folder that's already gone
 * or never existed is treated as a no-op, matching `eliminarArchivo`'s
 * "cleanup never throws for already-gone resources" contract.
 *
 * @param {string} folder
 * @returns {Promise<void>}
 */
export async function eliminarCarpeta(folder) {
  configurar();

  try {
    await cloudinary.api.delete_folder(folder);
  } catch (error) {
    if (error?.error?.http_code === 404) return;
    throw error;
  }
}

/**
 * Lista las imágenes que hay dentro de una carpeta de Cloudinary.
 *
 * Usa la Admin API (`api.resources`), no la de entrega: es la única que sabe
 * enumerar. Devuelve solo `image` — el flujo de n8n no genera video.
 *
 * El prefijo lleva **barra final a propósito**: sin ella,
 * `productos/YIMA-ABC` también matchearía `productos/YIMA-ABCD-123` y traería
 * la media de otro producto. Ese error no falla, devuelve de más.
 *
 * Una carpeta inexistente devuelve `[]` y no lanza: es el estado normal de un
 * producto al que todavía no se le generó nada, mismo criterio de "lo que no
 * está no es un error" que ya usan `eliminarArchivo` y `eliminarCarpeta`.
 *
 * @param {string} folder ruta de la carpeta, sin barra final
 * @returns {Promise<Array<{publicId: string, url: string, nombre: string}>>}
 */
export async function listarImagenesDeCarpeta(folder) {
  configurar();

  let respuesta;
  try {
    respuesta = await cloudinary.api.resources({
      type: "upload",
      resource_type: "image",
      prefix: `${folder}/`,
      max_results: 100,
    });
  } catch (error) {
    if (error?.error?.http_code === 404) return [];
    throw error;
  }

  return (respuesta.resources ?? [])
    .map((recurso) => ({
      publicId: recurso.public_id,
      url: recurso.secure_url,
      nombre: recurso.public_id.split("/").pop(),
    }))
    // Por nombre de archivo: el flujo los numera `{sku}-1` … `{sku}-5` y ese
    // número ES el rol de cada imagen (portada, en uso, beneficio…).
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true }));
}
