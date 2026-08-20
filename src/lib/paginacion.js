/** Tamaño de página por defecto cuando la query no pide uno válido. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * Tope duro de filas por página. Existe para que nadie pueda pedir la tabla
 * entera en una sola request: `ErrorLog`, `AuditLog` y `Orden` crecen sin
 * límite y un `pageSize=999999` sería un DoS gratis contra la base.
 */
export const MAX_PAGE_SIZE = 100;

/**
 * Parsea `page`/`pageSize` de la query string con defaults y tope compartidos.
 *
 * Valores fraccionarios, no numéricos, negativos o cero caen al default en vez
 * de tirar 500, y `pageSize` se clampea a `MAX_PAGE_SIZE`.
 *
 * Lo usan los listados paginados del admin (`admin.controller.js`'s
 * `listarErrorLogs` y `listarAuditLogs`, y `ordenes.controller.js`'s `listar`),
 * que además comparten el shape de respuesta `{ data, page, pageSize, total }`.
 * Antes estaba duplicado en los dos archivos junto con sus constantes: subir el
 * tope era un cambio en dos lugares que era fácil hacer a medias.
 *
 * @param {Record<string, unknown>} query - `req.query`
 * @returns {{ page: number, pageSize: number }}
 */
export function parsearPaginacion(query) {
  const pageParsed = Math.floor(Number(query.page));
  const page = Number.isFinite(pageParsed) && pageParsed > 0 ? pageParsed : 1;

  const pageSizeParsed = Math.floor(Number(query.pageSize));
  const pageSize =
    Number.isFinite(pageSizeParsed) && pageSizeParsed > 0
      ? Math.min(pageSizeParsed, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  return { page, pageSize };
}
