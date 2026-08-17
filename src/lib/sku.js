const PREFIJO = "YIMA";

/**
 * Genera el SKU de un producto: YIMA-{6 letras/números del nombre}-{id}.
 * Se llama una única vez al crear el producto (id ya asignado) — nunca se
 * recalcula si el nombre cambia después, para no invalidar un SKU ya
 * impreso o referenciado externamente.
 *
 * @param {string} nombre
 * @param {number} id
 * @returns {string}
 */
export function generarSku(nombre, id) {
  const segmento = nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita diacríticos (tildes, diéresis)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "") // solo alfanumérico
    .slice(0, 6);

  return `${PREFIJO}-${segmento}-${id}`;
}
