import { Decimal } from "@prisma/client/runtime/client.js";
import { subtotalDeItem } from "./dinero.js";

/**
 * Agrupa las filas de `ItemOrden` de una orden en líneas de PRESENTACIÓN: una
 * fila suelta queda tal cual, y todas las filas con el MISMO `comboId` se
 * juntan en una sola línea "Kit Living × N — $total" con sus productos.
 *
 * Los productos se listan por UN combo (spec §3.6: "Kit Living × 2" y debajo
 * "2× Lámpara · Mesa"), sumando las filas del mismo producto que el reparto
 * del precio partió en dos (`repartirPrecioCombo`, spec §5).
 *
 * Puramente de presentación: no persiste nada, se recalcula cada vez a partir
 * de `items` — spec §6.4. Sirve tanto a `ordenes.mapper.js` (admin y "Mis
 * pedidos") como a `plantillasEmail.js` (los mails), que reciben la fila
 * CRUDA de Prisma y la mapeada respectivamente: las dos formas tienen los
 * mismos nombres de campo (`nombreProducto`, `cantidad`, `comboId`,
 * `comboNombre`, `comboCantidad`), así que esta función sirve a las dos sin
 * ninguna adaptación.
 *
 * @param {Array<{productId: number|null, nombreProducto: string, precioUnitario: string|number, cantidad: number, comboId: number|null, comboNombre: string|null, comboCantidad: number|null}>} items
 * @returns {Array<{tipo: "PRODUCTO", item: object} | {tipo: "COMBO", comboId: number, comboNombre: string, comboCantidad: number, productos: Array<{nombreProducto: string, cantidad: number}>, total: string}>}
 */
export function agruparLineasOrden(items) {
  const grupos = [];
  const porCombo = new Map();

  for (const item of items) {
    if (item.comboId === null || item.comboId === undefined) {
      grupos.push({ tipo: "PRODUCTO", item });
      continue;
    }

    let grupo = porCombo.get(item.comboId);
    if (!grupo) {
      grupo = {
        tipo: "COMBO",
        comboId: item.comboId,
        comboNombre: item.comboNombre,
        comboCantidad: item.comboCantidad,
        _productos: new Map(),
        _total: new Decimal(0),
      };
      porCombo.set(item.comboId, grupo);
      grupos.push(grupo);
    }
    const clave = `${item.productId}:${item.nombreProducto}`;
    const previo = grupo._productos.get(clave);
    grupo._productos.set(clave, {
      nombreProducto: item.nombreProducto,
      cantidad: (previo?.cantidad ?? 0) + item.cantidad,
    });
    grupo._total = grupo._total.plus(subtotalDeItem(item));
  }

  return grupos.map((grupo) => {
    if (grupo.tipo !== "COMBO") return grupo;
    const { _total, _productos, ...resto } = grupo;
    const combosComprados = resto.comboCantidad > 0 ? resto.comboCantidad : 1;
    return {
      ...resto,
      productos: [..._productos.values()].map((p) => ({
        nombreProducto: p.nombreProducto,
        cantidad: p.cantidad / combosComprados,
      })),
      total: _total.toFixed(0),
    };
  });
}
