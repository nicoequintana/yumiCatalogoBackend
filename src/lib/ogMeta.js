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
 * Resuelve la URL absoluta a usar como og:image para un producto,
 * según el storage backend de su primera foto (por `orden` asc).
 *
 * @param {{ id: number, fotos: Array<{ orden: number, url: string, cloudinaryPublicId: string | null, driveFileId: string | null }> }} producto
 * @param {{ frontendUrl: string, backendUrl: string }} urls
 * @returns {string}
 */
export function resolverImagenOg(producto, { frontendUrl, backendUrl }) {
  const fotos = [...(producto.fotos ?? [])].sort((a, b) => a.orden - b.orden);
  const primera = fotos[0];

  // El fallback es un PNG y NO puede volver a ser un SVG: los scrapers de
  // WhatsApp, Facebook, Twitter y LinkedIn no renderizan SVG como og:image, y
  // la tarjeta sale sin imagen. Fue exactamente el bug que tenía este camino.
  // Es el mismo archivo que usa el Open Graph del sitio en `frontend/index.html`
  // — un producto sin foto y la home tienen la misma necesidad: mostrar la marca.
  if (!primera) return `${frontendUrl}/og-default.png`;
  if (primera.cloudinaryPublicId) return primera.url;
  if (primera.driveFileId) return `${backendUrl}/api/products/${producto.id}/fotos/${primera.id}`;
  return primera.url;
}
