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

/**
 * Genera un SKU único por cada nombre de un lote, sin colisionar entre sí ni
 * contra los que ya existen en la base.
 *
 * `generarSku` usa un sufijo random de 4 dígitos: dos productos con nombres
 * parecidos en el mismo lote pueden colisionar. Como todos los SKU de un
 * lote se generan ANTES de escribir a la base, la colisión se resuelve acá,
 * en memoria: se regenera hasta encontrar uno libre. Una colisión contra un
 * SKU que ya está en la base (fuera de este lote) sigue cayendo en el P2002
 * del error handler central.
 *
 * @param {string[]} nombres nombres de producto, en el orden en que se van a crear
 * @param {Set<string>} [skusExistentes] skus ya ocupados en la base — nunca se reutilizan
 * @returns {string[]} un sku por nombre, en el mismo orden
 */
export function generarSkusUnicos(nombres, skusExistentes = new Set()) {
  const skusDelLote = new Set();

  return nombres.map((nombre) => {
    let sku = generarSku(nombre);
    let intentos = 0;
    while ((skusDelLote.has(sku) || skusExistentes.has(sku)) && intentos < 10) {
      sku = generarSku(nombre);
      intentos += 1;
    }
    skusDelLote.add(sku);
    return sku;
  });
}
