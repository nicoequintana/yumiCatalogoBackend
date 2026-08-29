import { Decimal } from "@prisma/client/runtime/client.js";

/**
 * Cálculo del precio de venta a partir del costo de adquisición.
 *
 *     precio = redondearACentenaArriba(costo × coeficiente)
 *
 * **`coeficiente` es un MULTIPLICADOR, no un porcentaje.** Un 2,05 significa
 * "×2,05" — el aumento real es del 105 %. Se llama así justamente para que un
 * 2,05 guardado no se pueda leer como "2,05 %" ni como "205 %", que son las
 * dos lecturas equivocadas de un campo llamado `porcentaje`.
 *
 * **Aritmética con `Decimal`, nunca con float** — misma regla invariable que
 * `lib/dinero.js`. Acá el riesgo es concreto y no teórico: `14504 * 2.05` en
 * punto flotante da `29733.200000000004`, y el día que un producto caiga justo
 * sobre un múltiplo de 100 esa basura lo empuja a la centena siguiente y le
 * suma $100 al precio de venta sin que nadie lo pida.
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
 * Redondea hacia arriba al múltiplo de 100 más cercano.
 *
 * **Hacia arriba y no al más cercano**, y no es una preferencia estética: a la
 * centena más cercana, un coeficiente de 2,05 se convierte en un 2,0494
 * efectivo (`16.810 → 16.800` pierde $10 por unidad) sin que nadie lo note. La
 * regla existe para que el precio nunca quede por debajo del margen pedido.
 *
 * Un valor que YA es múltiplo de 100 se queda donde está — `ceil` lo garantiza.
 * Con un `+ 100` ingenuo, cada aplicación sucesiva le sumaría $100 al producto.
 *
 * @param {Decimal} valor
 * @returns {Decimal}
 */
export function redondearACentenaArriba(valor) {
  return valor.div(100).ceil().mul(100);
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

  return redondearACentenaArriba(costoDecimal.mul(coeficienteDecimal));
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
