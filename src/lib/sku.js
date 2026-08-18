const PREFIJO = "YIMA";

/**
 * Genera el SKU de un producto: YIMA-{6 letras/números del nombre}-{4 dígitos
 * al azar}. No depende del id autoincremental: se necesita ANTES del
 * `prisma.product.create()` (sku es NOT NULL en el schema), momento en el
 * que el id todavía no existe. El sufijo random es lo que evita colisiones
 * entre productos con nombres similares en su lugar.
 *
 * @param {string} nombre
 * @returns {string}
 */
export function generarSku(nombre) {
  const segmento = nombre
    .normalize("NFD")
    // Quita diacríticos (tildes, diéresis) del bloque Unicode "Combining
    // Diacritical Marks" (U+0300–U+036F). Efecto intencional: ñ -> n + tilde
    // combinante, que esta regex también elimina, quedando "n" (accent-folding).
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "") // solo alfanumérico
    .slice(0, 6);

  const sufijo = String(Math.floor(1000 + Math.random() * 9000));

  return `${PREFIJO}-${segmento}-${sufijo}`;
}
