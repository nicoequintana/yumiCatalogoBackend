import { Decimal } from "@prisma/client/runtime/client.js";

/**
 * Aritmética monetaria del sistema. Es el ÚNICO lugar donde se multiplica y se
 * suma plata.
 *
 * REGLA INVARIABLE — nunca con `float`. Acumular `0.10 * 7` diez veces en
 * punto flotante da `7.000000000000001`, y eso es facturación mal calculada.
 * Todo pasa por `Decimal`.
 *
 * De dónde sale la plata: SIEMPRE de los snapshots de `ItemOrden`
 * (`precioUnitario * cantidad`), nunca del `precio` vivo de `Product` — un
 * cambio de precio no debe reescribir la facturación histórica.
 *
 * Este reducer estaba escrito tres veces (inline en `resumenVentas`, como
 * `totalDeOrden` en `adminClientes.controller.js` y como `totalDeItems` en
 * `adminOperacion.controller.js`). Tres copias son tres lugares donde alguien
 * puede "simplificar" una a float y corromper la facturación en silencio.
 */

/**
 * `precioUnitario * cantidad` de un solo ítem, en `Decimal`.
 *
 * `precioUnitario` llega como `Decimal` desde Prisma, pero se normaliza igual:
 * en tests o mocks puede venir como string o number, y `Decimal` acepta las
 * tres formas sin perder precisión.
 *
 * @param {{ precioUnitario: unknown, cantidad: number }} item
 * @returns {Decimal}
 */
export function subtotalDeItem(item) {
  return new Decimal(item.precioUnitario).mul(item.cantidad);
}

/**
 * Total facturado de una lista de ítems de orden.
 *
 * Tolera `items` ausente (`null`/`undefined`) devolviendo cero: los tableros
 * del admin arman consultas con `include` variable y una orden sin ítems
 * cargados vale cero, no revienta.
 *
 * @param {Array<{ precioUnitario: unknown, cantidad: number }> | null | undefined} items
 * @returns {Decimal}
 */
export function totalDeItems(items) {
  return (items ?? []).reduce((acumulado, item) => acumulado.plus(subtotalDeItem(item)), new Decimal(0));
}

/**
 * Suma una lista de `Decimal` ya calculados.
 *
 * Existe para que quien necesite los subtotales ítem por ítem (el ranking de
 * productos de `resumenVentas`) pueda calcularlos UNA sola vez y sumarlos
 * después, en vez de recorrer los ítems dos veces multiplicando lo mismo.
 *
 * @param {Decimal[]} valores
 * @returns {Decimal}
 */
export function sumarDecimales(valores) {
  return valores.reduce((acumulado, valor) => acumulado.plus(valor), new Decimal(0));
}
