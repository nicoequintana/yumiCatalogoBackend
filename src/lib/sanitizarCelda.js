/**
 * Neutraliza la inyección de fórmulas (formula/CSV injection) en las celdas de
 * texto de los `.xlsx` que el sistema EXPORTA.
 *
 * **El riesgo.** Un valor de texto que empieza con `=`, `+`, `-`, `@`, TAB o CR
 * es interpretado por Excel / LibreOffice / Google Sheets como una FÓRMULA al
 * abrir el archivo. Como el nombre de un producto es texto libre que carga el
 * admin (y el `nombreProducto` de una orden es su snapshot), un nombre como
 * `=HYPERLINK(...)` o `=cmd|...` se ejecutaría en la máquina de quien abra la
 * exportación. Es una vulnerabilidad de salida, no de la base.
 *
 * **La defensa** (recomendación de OWASP): si el string empieza con uno de esos
 * caracteres, se le antepone un apóstrofo `'`, que fuerza a la celda a tratarse
 * como texto literal.
 *
 * Solo actúa sobre STRINGS: los números (costo, coeficiente, stock, unidades)
 * pasan intactos — anteponerles un apóstrofo los volvería "número almacenado
 * como texto" y rompería las validaciones y sumas del archivo.
 *
 * **No aplicar a columnas que son clave de match en un round-trip** (p. ej. el
 * `sku` de la exportación que vuelve a subirse): el prefijo cambiaría el valor y
 * el matcheo por SKU fallaría. Se aplica al `nombre`, que no es clave.
 *
 * @param {*} valor el valor de la celda
 * @returns {*} el valor saneado si era un string peligroso; el mismo valor si no
 */
export function sanitizarCelda(valor) {
  if (typeof valor !== "string" || valor === "") return valor;
  // `=` `+` `-` `@` fórmula; `\t` (TAB) y `\r` (CR) también disparan la
  // interpretación como fórmula en varias hojas de cálculo.
  if (/^[=+\-@\t\r]/.test(valor)) return `'${valor}`;
  return valor;
}
