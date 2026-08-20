/**
 * Cliente de la API oficial de MercadoLibre, usado por los scripts de
 * generación de fichas. Se usa la API y no scraping del HTML porque el sitio
 * renderiza del lado del cliente y tiene protección anti-bot; la API devuelve
 * datos estructurados y estables.
 *
 * IMPORTANTE: los datos que devuelve son INSUMO DE HECHOS. Las publicaciones
 * que se consultan no son del dueño del catálogo, así que su redacción y sus
 * fotos no se copian nunca — ver el spec del 2026-08-19.
 */

/**
 * Saca el id de ítem (`MLA...`) de una URL de MercadoLibre.
 *
 * ML tiene varias formas de URL para lo mismo (artículo con guion, producto de
 * catálogo sin guion, con query params de tracking), así que se busca el
 * patrón en cualquier parte del texto en vez de parsear la ruta.
 *
 * @returns {string|null} el id normalizado sin guion, o null si no hay ninguno
 */
export function extraerIdML(url) {
  if (!url) return null;

  const match = String(url).match(/\b(ML[A-Z])-?(\d+)\b/);
  return match ? `${match[1]}${match[2]}` : null;
}
