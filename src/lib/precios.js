import { Decimal } from "@prisma/client/runtime/client.js";

/**
 * Cálculo del precio de venta a partir del costo de adquisición.
 *
 *     precio = redondearAEntero(costo × coeficiente)
 *
 * **`coeficiente` es un MULTIPLICADOR, no un porcentaje.** Un 2,05 significa
 * "×2,05" — el aumento real es del 105 %. Se llama así justamente para que un
 * 2,05 guardado no se pueda leer como "2,05 %" ni como "205 %", que son las
 * dos lecturas equivocadas de un campo llamado `porcentaje`.
 *
 * **Aritmética con `Decimal`, nunca con float** — misma regla invariable que
 * `lib/dinero.js`. `14504 * 2.05` en punto flotante da `29733.200000000004`, y
 * aunque con el redondeo al entero esa basura ya no cambia el resultado, un
 * valor que caiga sobre el medio peso exacto sí queda a merced de cómo el float
 * lo haya representado: `6457.5` puede venir como `6457.499999…` y redondear
 * para el lado equivocado.
 *
 * ⚠️ **Espejo manual de `frontend/src/utils/precios.js`.** Los dos repos se
 * publican por separado (ver CLAUDE.md, "Deploy"), así que no hay forma de
 * compartir el módulo — mismo caso que `lib/slug.js` ↔ `utils/slug.js` y
 * `lib/jsonLd.js` ↔ `utils/jsonLd.js`. La copia del frontend no tiene `Decimal`
 * y resuelve lo mismo con aritmética entera; los dos tienen el mismo set de
 * casos en sus tests. **Si divergen, el admin ve en pantalla un precio distinto
 * del que el backend escribe** — sin error y sin nada que lo delate.
 */

/**
 * Estados posibles de un producto respecto de su precio calculado.
 *
 * Son DERIVADOS, no persistidos: no hay columna de estado en `Product`. Se
 * calculan al leer, así que no pueden quedar desactualizados.
 */
export const ESTADOS_PRECIO = {
  /** Falta el costo o el coeficiente: el precio es manual, como antes de esta feature. */
  SIN_COSTO: "SIN_COSTO",
  /** El precio publicado es exactamente el que da el cálculo. */
  AL_DIA: "AL_DIA",
  /** Hay costo y coeficiente, pero el precio publicado es otro. */
  DIFIERE: "DIFIERE",
};

/**
 * Normaliza a `Decimal` un valor que puede llegar como `Decimal` (Prisma),
 * string (JSON) o number (tests, formularios), y descarta lo que no sirve.
 *
 * @returns {Decimal|null} `null` si falta, no parsea, o no es positivo
 */
function aDecimalPositivo(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  try {
    const decimal = new Decimal(valor);
    if (!decimal.isFinite() || decimal.lte(0)) return null;
    return decimal;
  } catch {
    return null;
  }
}

/**
 * Redondea al peso más cercano, con el medio peso exacto hacia arriba.
 *
 * **Hasta el 29/08/2026 esto redondeaba a la centena hacia arriba** y se
 * cambió por pedido explícito: `3.075 × 2,05 = 6.303,75` se publicaba como
 * `6.400`, casi cien pesos por encima de la cuenta. Con los costos ya cargados
 * el argumento original (que a la centena más cercana un 2,05 se vuelve un
 * 2,0494 efectivo) dejó de compensar: el redondeo comercial movía el catálogo
 * entero casi $4.000 y el error que evitaba era de centavos.
 *
 * El precio sigue siendo entero — la columna es `Decimal(10, 0)` y un decimal
 * ahí se guardaría redondeado sin avisar (ver "Montos enteros" en CLAUDE.md).
 * Lo que cambió es cuánto se redondea, no que se redondee.
 *
 * @param {Decimal} valor
 * @returns {Decimal}
 */
export function redondearAEntero(valor) {
  // ROUND_HALF_UP explícito y no el modo por defecto de la instancia: el
  // default de decimal.js es configurable en tiempo de ejecución, así que
  // dejarlo implícito haría que el precio del catálogo dependiera de que nadie
  // toque `Decimal.set()` en otra parte del proceso.
  return valor.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/**
 * Precio de venta que corresponde a un costo y un coeficiente.
 *
 * Devuelve `null` —nunca 0— cuando falta alguno de los dos o no son positivos:
 * un 0 se escribiría como precio del producto, que es peor que no calcular nada.
 *
 * @param {Decimal|string|number|null|undefined} costo
 * @param {Decimal|string|number|null|undefined} coeficiente
 * @returns {Decimal|null}
 */
export function calcularPrecio(costo, coeficiente) {
  const costoDecimal = aDecimalPositivo(costo);
  const coeficienteDecimal = aDecimalPositivo(coeficiente);
  if (costoDecimal === null || coeficienteDecimal === null) return null;

  return redondearAEntero(costoDecimal.mul(coeficienteDecimal));
}

/**
 * En cuál de los tres estados está un producto respecto de su precio.
 *
 * `DIFIERE` cubre tres causas que el sistema NO puede distinguir entre sí:
 * subió el costo, cambió el coeficiente, o el admin pisó el precio a mano desde
 * el editor. Por eso no se llama "desactualizado": un precio elegido a propósito
 * es legítimo, y un panel que lo marque como problema todos los días entrena a
 * ignorar el aviso.
 *
 * @param {{ precio: unknown, costo: unknown, coeficiente: unknown }} producto
 * @returns {string} una de las claves de `ESTADOS_PRECIO`
 */
export function estadoDePrecio({ precio, costo, coeficiente }) {
  const calculado = calcularPrecio(costo, coeficiente);
  if (calculado === null) return ESTADOS_PRECIO.SIN_COSTO;

  const vigente = aDecimalPositivo(precio);
  if (vigente === null) return ESTADOS_PRECIO.DIFIERE;

  // Comparación por VALOR: `Decimal("20500")` y `Decimal("20500.00")` son el
  // mismo dinero. Un `===` sobre strings los daría por distintos y marcaría
  // DIFIERE un producto que está al día.
  return vigente.equals(calculado) ? ESTADOS_PRECIO.AL_DIA : ESTADOS_PRECIO.DIFIERE;
}
