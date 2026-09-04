/**
 * Resuelve la URL pública de una foto.
 *
 * `foto.url` ya contiene la URL directa del CDN de Cloudinary para todo lo
 * subido por el catálogo. Las filas de seed/placeholder tampoco tienen
 * `cloudinaryPublicId` y conservan su URL original, así que el mismo `return`
 * las cubre.
 *
 * Antes había una rama intermedia que ruteaba las fotos legadas de Google Drive
 * por un proxy propio del backend (una URL cruda de Drive dispara
 * `net::ERR_BLOCKED_BY_ORB` en Chromium por el Content-Type ambiguo de su
 * redirect). Ese storage se retiró del proyecto: no quedaba ninguna foto
 * apoyada en él —327 de 327 en producción salen de Cloudinary— y sostenerlo
 * costaba 208 MB de dependencia en la imagen del contenedor.
 *
 * Sigue existiendo —aunque hoy sea un solo `return`— para que la portada de la
 * grilla, la galería del detalle, la miniatura de una línea de orden y la
 * vitrina de una campaña no puedan divergir si vuelve a aparecer un segundo
 * storage.
 *
 * Vivía en `controllers/products.mapper.js`, que anotaba que al aparecer un
 * CUARTO consumidor había que mudarla acá. Pasó: el cuarto es la vitrina de
 * `campanias.controller.js`. Los otros tres son `mapProducto`,
 * `mapProductoListado` y `ordenes.mapper.js`.
 */
export function urlDeFoto(foto) {
  return foto.url;
}
