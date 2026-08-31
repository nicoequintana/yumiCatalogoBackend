/**
 * Escapa los metacaracteres de LIKE de SQL Server dentro de un término de
 * búsqueda, para que un `contains` de Prisma los trate como texto literal en
 * lugar de comodines.
 *
 * **Por qué existe.** `GET /products?search=` y `GET /ordenes?nombre=` arman un
 * `{ contains: termino }`, que Prisma compila a `LIKE '%termino%'`. Prisma
 * parametriza el valor (no hay riesgo de inyección SQL), pero NO escapa los
 * comodines de LIKE: `%`, `_` y `[` viajan activos. Sin este escape, buscar
 * `50%` matchea cualquier producto (el `%` es "cualquier cosa"), `a_b` matchea
 * `axb`, y `[abc]` se interpreta como una clase de caracteres. Es una fuga de
 * comportamiento en un endpoint público, no un formateo cosmético.
 *
 * **Por qué la técnica de la clase de caracteres y no un backslash.** La forma
 * habitual de escapar (`\%`) EXIGE declarar una cláusula `ESCAPE '\'` en el
 * `LIKE`. El conector `@prisma/adapter-mssql` de `contains` no emite esa
 * cláusula, así que un backslash queda como caracter literal y NO neutraliza
 * nada — verificado end-to-end contra SQL Server real (ver
 * `products.search-like.integration.test.js`): `contains: "50\\%OFF"` no
 * matcheaba ni el literal `50%OFF`. La única técnica que funciona sin cláusula
 * ESCAPE es envolver cada metacaracter en una clase de un solo caracter:
 *
 *   `%` -> `[%]`   `_` -> `[_]`   `[` -> `[[]`
 *
 * Dentro de `[...]`, esos caracteres pierden su significado especial y matchean
 * el literal. Esto también se verificó contra SQL Server real: `contains
 * "50[%]OFF"` matchea solo el literal `50%OFF`.
 *
 * `]` y `\` NO se escapan a propósito: fuera de una clase de caracteres, y sin
 * cláusula ESCAPE, los dos son literales en LIKE. Los tres metacaracteres reales
 * de SQL Server son exactamente `%`, `_` y `[`.
 *
 * El reemplazo es una ÚNICA pasada sobre el término original (regex global), de
 * modo que los corchetes que este mismo escape agrega no se vuelven a procesar.
 *
 * @param {string} termino término de búsqueda ya trimmeado
 * @returns {string} el término con sus metacaracteres de LIKE escapados
 */
export function escaparLike(termino) {
  return String(termino).replace(/[[%_]/g, (caracter) => `[${caracter}]`);
}
