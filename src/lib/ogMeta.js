/**
 * Trunca un texto a `maxLength` caracteres, cortando en el límite de
 * palabra más cercano hacia atrás (nunca a mitad de palabra), y agrega
 * "…" cuando hubo corte.
 *
 * @param {string} texto
 * @param {number} maxLength
 * @returns {string}
 */
export function truncarDescripcion(texto, maxLength) {
  if (!texto || texto.length <= maxLength) return texto ?? "";

  const cortado = texto.slice(0, maxLength);
  const ultimoEspacio = cortado.lastIndexOf(" ");
  const base = ultimoEspacio > 0 ? cortado.slice(0, ultimoEspacio) : cortado;

  return `${base}…`;
}

/**
 * Resuelve la URL absoluta a usar como og:image para un producto: la primera
 * foto por `orden`, o la imagen de marca si el producto no tiene ninguna.
 *
 * Las fotos se sirven SIEMPRE por la URL directa del CDN de Cloudinary, que es
 * lo que `foto.url` ya contiene. Antes había una tercera rama que ruteaba las
 * fotos legadas de Google Drive por un proxy propio del backend; ese storage se
 * retiró del proyecto, y con él la rama y el parámetro `backendUrl` que solo
 * ella usaba.
 *
 * @param {{ id: number, fotos: Array<{ orden: number, url: string }> }} producto
 * @param {{ frontendUrl: string }} urls
 * @returns {string}
 */
export function resolverImagenOg(producto, { frontendUrl }) {
  const fotos = [...(producto.fotos ?? [])].sort((a, b) => a.orden - b.orden);
  const primera = fotos[0];

  // El fallback es un PNG y NO puede volver a ser un SVG: los scrapers de
  // WhatsApp, Facebook, Twitter y LinkedIn no renderizan SVG como og:image, y
  // la tarjeta sale sin imagen. Fue exactamente el bug que tenía este camino.
  // Es el mismo archivo que usa el Open Graph del sitio en `frontend/index.html`
  // — un producto sin foto y la home tienen la misma necesidad: mostrar la marca.
  if (!primera) return `${frontendUrl}/og-default.png`;
  return primera.url;
}
