/**
 * La guarda de RANGO de todo número que viaja a Prisma como entero.
 *
 * `Number.isInteger` valida la FORMA, no el TAMAÑO: `Number("1e21")` es un
 * entero positivo perfectamente válido para JavaScript, así que pasaba las
 * guardas de `?campania=`, `?categoria=`, `?ids=`, `?page=` y de toda la
 * familia `/:id`, llegaba al query engine y lo hacía cortar con *"Unable to fit
 * value 1e+21 into a 64-bit signed integer"*. Ese error no lleva `status`, así
 * que el handler global lo vuelve **500 en un endpoint público**, más su fila
 * en `ErrorLog`, y basta con manosear una URL para dispararlo.
 *
 * **La frontera es `Number.isSafeInteger`, no el rango de la columna `Int`.**
 * Se midió contra el SQL Server real, no se dedujo del schema:
 * `?campania=9007199254740991` (2^53 - 1) responde 200 y
 * `?campania=9007199254740993` responde 500. Un valor mayor que
 * `MAX_SAFE_INTEGER` ya no se puede representar exacto como `Number`, y es ahí
 * —antes del límite de la columna— donde Prisma se planta. Acotar por
 * `2147483647` sería más estricto, pero cambiaría el significado de valores que
 * hoy funcionan: `?categoria=2147483648` responde 200 con cero resultados, y
 * pasar a descartar el filtro devolvería el catálogo entero.
 *
 * Fuera de rango se DESCARTA en silencio, que es la política que este endpoint
 * público ya aplica al resto de sus filtros: un valor que no se entiende no
 * filtra, no tira 400.
 */

/**
 * ¿Este número puede viajar a Prisma como entero sin reventar el query engine?
 *
 * Recibe un número ya convertido: no parsea. Para el par "convertir y validar"
 * está `parsearIdEntero`.
 *
 * @param {unknown} numero
 * @returns {boolean}
 */
export function esEnteroSeguro(numero) {
  return Number.isSafeInteger(numero);
}

/**
 * El id positivo que representa `valor`, o `null` si no hay uno usable.
 *
 * Devuelve `null` —y nunca lanza— para todo lo demás: no numérico, fraccionario,
 * cero, negativo, fuera de rango, ausente, o un array (que es como llega un
 * parámetro repetido, `?campania=1&campania=2`). El llamador decide qué
 * significa esa ausencia; acá no se asume ni un 404 ni un filtro vacío.
 *
 * @param {unknown} valor
 * @returns {number|null}
 */
export function parsearIdEntero(valor) {
  const numero = Number(valor);
  return esEnteroSeguro(numero) && numero > 0 ? numero : null;
}
