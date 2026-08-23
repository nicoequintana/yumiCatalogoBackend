/**
 * Normaliza un DNI (Documento Nacional de Identidad argentino) recibido en
 * cualquier formato de escritura humana ("12.345.678", "12 345 678", etc.)
 * a un string de solo dígitos. Se usa como paso previo obligatorio a
 * `esDniValido` y a cualquier lookup/upsert de `Cliente` por dni — así
 * "12.345.678" y "12345678" resuelven siempre a la misma clave única en la
 * tabla, evitando clientes duplicados por diferencias de formato de tipeo.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizarDni(raw) {
  return String(raw ?? "").replace(/\D/g, "");
}

/**
 * Valida que un DNI ya normalizado (ver `normalizarDni`) tenga 7 u 8 dígitos
 * — el rango real de longitud de un DNI argentino. No normaliza por su
 * cuenta: el caller debe llamar `normalizarDni` primero, así el orden
 * normalizar -> validar queda explícito en el código que llama a ambas.
 *
 * @param {string} dni
 * @returns {boolean}
 */
export function esDniValido(dni) {
  return typeof dni === "string" && /^\d{7,8}$/.test(dni);
}
