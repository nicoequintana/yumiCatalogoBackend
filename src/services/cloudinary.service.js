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
 * delete) a video asset. No per-product folder structure (design decision;
 * unlike Drive, Cloudinary uploads are not organized per-product).
 *
 * @param {Buffer} buffer - raw file bytes
 * @param {"image"|"video"} resourceType
 * @returns {Promise<{ cloudinaryPublicId: string, cloudinaryResourceType: string, url: string }>}
 */
export function subirArchivo(buffer, resourceType) {
  configurar();

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          cloudinaryPublicId: result.public_id,
          cloudinaryResourceType: result.resource_type,
          url: result.secure_url,
        });
      },
    );
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
