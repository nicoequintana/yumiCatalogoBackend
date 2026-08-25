/**
 * Subida y limpieza de la media de un producto contra el storage remoto.
 *
 * Concentra el trato con Cloudinary (storage principal) y con Google Drive
 * (legado de solo lectura/limpieza), incluido el contrato anti-huérfanos que
 * describe `subirArchivosNuevos`. Los controllers de producto solo orquestan:
 * ninguna de estas funciones sabe de rutas, de `res` ni del modelo de Prisma.
 */

import * as googleDrive from "./googleDrive.service.js";
import * as cloudinary from "./cloudinary.service.js";
import { logError } from "../lib/logError.js";
/**
 * Sanitizes a free-text product name for use as a Cloudinary folder path
 * segment. Cloudinary's `folder` param treats `/` as a path separator, so an
 * unsanitized name containing `/` (e.g. "Anillo/Oro 18k") would silently
 * create nested subfolders instead of one flat per-product folder. Replaces
 * `/` and other path-meaningful characters with `-`.
 *
 * @param {string} nombre
 * @returns {string}
 */
export function sanitizarNombreParaCarpeta(nombre) {
  return nombre.replace(/[/\\?%*:|"<>]/g, "-");
}

/** Normaliza la respuesta de `cloudinary.subirArchivo` a lo que guarda la DB. */
function aArchivoSubido({ cloudinaryPublicId, cloudinaryResourceType, url }) {
  return { cloudinaryPublicId, cloudinaryResourceType, url };
}

/**
 * Sube a Cloudinary las fotos nuevas y el video opcional, TODOS EN PARALELO,
 * y devuelve sus metadatos para las escrituras en la base.
 *
 * Por qué en paralelo: antes era un `for` con `await` adentro, así que diez
 * fotos de ~2s cada una eran un request de ~20s. Además, cuanto más larga la
 * subida, más expuesta queda al timeout de inactividad de 60s del SDK
 * (`cloudinary.service.js`) que ya nos mordió en producción.
 *
 * Sin límite de concurrencia a propósito: `validarArchivos` ya acota la tanda
 * a `MAX_FOTOS` fotos + 1 video (11 requests como techo absoluto), y multer
 * guarda los buffers en memoria antes de llegar acá, así que serializar no
 * ahorraría ni una sola conexión en vuelo *menos* memoria — solo tiempo de
 * pared. Un tope artificial acá volvería a serializar sin beneficio.
 *
 * CONTRATO ANTI-HUÉRFANOS (design D6, heredado del código de la era Drive):
 * si alguna subida falla, las que sí terminaron bien se borran de Cloudinary
 * para no dejar archivos sueltos que ya nadie referencia.
 *
 * Es `Promise.allSettled` y NO `Promise.all` por ese contrato: `Promise.all`
 * rechaza apenas falla una y devuelve el control mientras las otras SIGUEN EN
 * VUELO — esas terminarían después de la limpieza y quedarían huérfanas justo
 * en el caso que el contrato existe para cubrir. `allSettled` espera a que
 * todas se asienten, así la limpieza ve la lista completa de subidas
 * exitosas. Es también el motivo por el que el paralelo es MÁS expuesto que
 * el bucle secuencial, donde una falla simplemente impedía que arrancaran las
 * siguientes.
 *
 * El orden de `fotosSubidas` es el orden de entrada, nunca el de finalización:
 * la posición de una foto es contenido (`fotos[0]` es la portada, `fotos[1]`
 * es la imagen de "¿qué problema resuelve?"), y `ordenFotos` indexa este array
 * por posición. Por eso se arma con `map` sobre los resultados —que
 * `allSettled` devuelve en el orden en que se pasaron las promesas— y nunca
 * con `push` desde un callback.
 */
export async function subirArchivosNuevos({ fotosNuevas, videoNuevo, folder }) {
  const resultados = await Promise.allSettled([
    ...fotosNuevas.map((foto) => cloudinary.subirArchivo(foto.buffer, "image", folder)),
    ...(videoNuevo ? [cloudinary.subirArchivo(videoNuevo.buffer, "video", folder)] : []),
  ]);

  const resultadosFotos = resultados.slice(0, fotosNuevas.length);
  const resultadoVideo = videoNuevo ? resultados[fotosNuevas.length] : null;

  const fallo = resultados.find((r) => r.status === "rejected");
  if (fallo) {
    await limpiarArchivosSubidos({
      fotos: resultadosFotos.filter((r) => r.status === "fulfilled").map((r) => aArchivoSubido(r.value)),
      video: resultadoVideo?.status === "fulfilled" ? aArchivoSubido(resultadoVideo.value) : null,
    });
    // Se propaga el primer rechazo en orden de entrada, no el primero en el
    // tiempo: el mensaje que ve el admin queda estable ante el azar de la red.
    throw fallo.reason;
  }

  return {
    fotosSubidas: resultadosFotos.map((r) => aArchivoSubido(r.value)),
    videoSubido: resultadoVideo ? aArchivoSubido(resultadoVideo.value) : null,
  };
}

/**
 * Registra una falla de limpieza de media (Cloudinary/Drive) en el ErrorLog
 * central, en vez del `console.error` suelto que había antes.
 *
 * Por qué estas fallas NO son un 500: la mutación de negocio (crear, editar o
 * borrar el producto) ya se completó y el cliente ya tiene su respuesta. Lo
 * único que falló es el borrado del archivo remoto, que deja un huérfano en
 * el storage — molesto y hay que poder verlo, pero no invalida la operación.
 * Antes ese rastro moría en los logs del contenedor; ahora queda consultable
 * desde el panel admin igual que cualquier otro error.
 *
 * `status: null` a propósito: no hay un status HTTP asociado (la respuesta al
 * cliente fue exitosa). `req` es opcional porque `limpiarArchivosSubidos` se
 * llama desde catch blocks que no siempre lo tienen a mano.
 *
 * Fire-and-forget, igual que el resto de los usos de `logError`.
 */
export function logFallaDeLimpieza(mensaje, err, req) {
  logError({
    mensaje: `${mensaje}: ${err?.message ?? err}`,
    stack: err?.stack,
    ruta: req?.originalUrl,
    metodo: req?.method,
    status: null,
  });
}

/**
 * Limpieza best-effort de una tanda recién subida a Cloudinary — nunca lanza,
 * se usa desde catch blocks. Los borrados van en paralelo por el mismo motivo
 * que las subidas: son N round trips independientes contra un servicio
 * externo, y acá el cliente ya está esperando la respuesta de un request que
 * además falló.
 *
 * Cada borrado lleva su propio `catch`, así que `Promise.all` no puede
 * rechazar; igual se usa `allSettled` para que un fallo imprevisto (por
 * ejemplo un throw sincrónico del SDK) no corte la limpieza de los demás.
 */
export async function limpiarArchivosSubidos({ fotos = [], video = null }, req) {
  const borrarConAviso = (archivo, descripcion) =>
    cloudinary
      .eliminarArchivo(archivo.cloudinaryPublicId, archivo.cloudinaryResourceType)
      .catch((err) =>
        logFallaDeLimpieza(`${descripcion} (${archivo.cloudinaryPublicId})`, err, req),
      );

  await Promise.allSettled([
    ...fotos.map((foto) => borrarConAviso(foto, "No se pudo limpiar la foto huérfana en Cloudinary")),
    ...(video ? [borrarConAviso(video, "No se pudo limpiar el video huérfano en Cloudinary")] : []),
  ]);
}

/**
 * Borra el archivo remoto de una foto o video YA eliminado de la base,
 * contra el storage que esa fila usaba: Drive para las filas legado,
 * Cloudinary para todo lo posterior a la migración (una fila tiene
 * exactamente uno de los dos ids seteado, nunca ambos).
 *
 * Devuelve una promesa que nunca rechaza — la falla se registra en el
 * ErrorLog y se traga, porque la mutación de negocio ya se completó y el
 * único daño posible es un archivo huérfano en el storage. Devolver la
 * promesa (en vez de esperarla adentro) es lo que deja a los llamadores
 * juntar varias limpiezas en un solo `Promise.allSettled`.
 *
 * @param {{driveFileId?: string|null, cloudinaryPublicId?: string|null, cloudinaryResourceType?: string|null}|null} media
 * @param {string} que - sujeto del mensaje de error, ej. "la foto".
 * @param {import("express").Request} [req]
 * @returns {Promise<void>}
 */
export function limpiarMediaRemota(media, que, req) {
  if (media?.driveFileId) {
    return googleDrive
      .eliminarArchivo(media.driveFileId)
      .catch((err) => logFallaDeLimpieza(`No se pudo eliminar ${que} en Drive`, err, req));
  }
  if (media?.cloudinaryPublicId) {
    return cloudinary
      .eliminarArchivo(media.cloudinaryPublicId, media.cloudinaryResourceType)
      .catch((err) => logFallaDeLimpieza(`No se pudo eliminar ${que} en Cloudinary`, err, req));
  }
  return Promise.resolve();
}
