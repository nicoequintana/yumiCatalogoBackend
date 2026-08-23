// Parseo de CORS_ORIGIN.
//
// EL BUG QUE ARREGLA: antes era `process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:5173"`.
// Eso devolvía un ARRAY cuando la variable estaba seteada y un STRING cuando
// no — dos tipos distintos para la misma configuración — y además nunca
// recortaba espacios. La forma natural de escribir varios orígenes,
// `"https://a.com, https://b.com"`, dejaba el segundo como `" https://b.com"`
// con un espacio adelante: `cors` compara el header `Origin` por igualdad
// exacta contra cada entrada, así que ese origen quedaba bloqueado en
// producción sin ningún error visible en los logs. El síntoma aparecía en el
// browser del cliente, no en el servidor.

export const ORIGEN_POR_DEFECTO = "http://localhost:5173";

/**
 * Convierte el valor crudo de CORS_ORIGIN en la lista de orígenes permitidos.
 *
 * Siempre devuelve un array (también el fallback de desarrollo), así el tipo
 * no cambia según el entorno. Recorta cada entrada y descarta las vacías, que
 * es lo que producen una coma de más o un salto de línea pegado al valor.
 *
 * @param {string | undefined | null} valorCrudo
 * @returns {string[]}
 */
export function parsearOrigenesCors(valorCrudo) {
  if (typeof valorCrudo !== "string") return [ORIGEN_POR_DEFECTO];

  const origenes = valorCrudo
    .split(",")
    .map((origen) => origen.trim())
    .filter((origen) => origen !== "");

  // Una variable seteada pero que no aporta ningún origen usable (vacía, o
  // solo comas) cae al default en vez de dejar la lista vacía: una lista
  // vacía bloquearía TODO, y una variable en blanco es casi siempre un campo
  // que quedó creado sin valor, no la intención de cerrar el CORS.
  return origenes.length > 0 ? origenes : [ORIGEN_POR_DEFECTO];
}
