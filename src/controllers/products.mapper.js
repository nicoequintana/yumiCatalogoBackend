/**
 * Forma de lectura de un producto: el `include` de Prisma que trae todas sus
 * relaciones y el mapeo de esa fila a la forma que devuelve la API.
 *
 * Vive separado del controller porque lo consumen varios controllers de
 * producto (el principal y el de importación) y no depende de nada más: es
 * puro, sin acceso a base ni a storage.
 */

export const PRODUCT_INCLUDE = {
  caracteristicas: true,
  fotos: { orderBy: { orden: "asc" } },
  video: true,
  categoria: true,
  listas: { orderBy: { orden: "asc" } },
  especificaciones: { orderBy: { orden: "asc" } },
};

/**
 * Maps a Prisma Product row (with relations) to the API response shape.
 *
 * Photo URLs (post-archive bugfix, see topic
 * "sdd/backend-drive-sqlserver/photo-proxy-postfix"): a raw
 * `drive.google.com/uc?export=view` URL triggers `net::ERR_BLOCKED_BY_ORB`
 * in real Chromium — Drive's redirect chain has an ambiguous Content-Type
 * on the initial 303 hop, which browsers now block for `<img>` requests.
 * `curl`/Node HTTP checks don't reproduce this because ORB is a browser-only
 * mitigation. Real uploaded photos (driveFileId set) are therefore routed
 * through the backend proxy (`streamFoto`, mirrors the existing video
 * proxy). Seed/placeholder photos (driveFileId null) keep their original
 * `placehold.co` URL untouched — there is nothing to proxy and no ORB risk
 * for that host.
 */
function agruparListasPorTipo(listas) {
  const porTipo = { BENEFICIO: [], USO: [], IDEAL_PARA: [], INCLUYE: [] };
  for (const item of listas) {
    porTipo[item.tipo]?.push({ id: item.id, texto: item.texto });
  }
  return porTipo;
}

export function mapProducto(producto) {
  return {
    id: producto.id,
    sku: producto.sku,
    nombre: producto.nombre,
    descripcion: producto.descripcion,
    precio: producto.precio.toString(),
    etiqueta: producto.etiqueta,
    categoria: producto.categoria ? { id: producto.categoria.id, nombre: producto.categoria.nombre } : null,
    vistas: producto.vistas,
    compartidos: producto.compartidos,
    favoritosCount: producto.favoritosCount,
    visibleEnCatalogo: producto.visibleEnCatalogo,
    stock: producto.stock,
    destacado: producto.destacado,
    orden: producto.orden,
    caracteristicas: producto.caracteristicas.map((c) => ({ id: c.id, texto: c.texto })),
    fraseComercial: producto.fraseComercial,
    porQueLoVasAQuerer: producto.porQueLoVasAQuerer,
    tePasaEsto: producto.tePasaEsto,
    beneficios: agruparListasPorTipo(producto.listas ?? []).BENEFICIO,
    usos: agruparListasPorTipo(producto.listas ?? []).USO,
    idealPara: agruparListasPorTipo(producto.listas ?? []).IDEAL_PARA,
    incluye: agruparListasPorTipo(producto.listas ?? []).INCLUYE,
    especificaciones: (producto.especificaciones ?? []).map((e) => ({ id: e.id, nombre: e.nombre, valor: e.valor })),
    // `driveFileId` NO se expone: la URL de arriba ya resuelve el storage del
    // lado del servidor (Cloudinary directo, o el proxy propio para las filas
    // legado de Drive), así que mandarlo solo filtraría un identificador
    // interno de storage en un endpoint público. Ningún cliente lo lee.
    fotos: producto.fotos.map((f) => ({
      id: f.id,
      url: f.cloudinaryPublicId ? f.url : f.driveFileId ? `/api/products/${producto.id}/fotos/${f.id}` : f.url,
      orden: f.orden,
    })),
    video: producto.video
      ? {
          id: producto.video.id,
          url: producto.video.cloudinaryPublicId
            ? producto.video.url
            : `/api/products/${producto.id}/video`,
        }
      : null,
    createdAt: producto.createdAt,
    updatedAt: producto.updatedAt,
  };
}
