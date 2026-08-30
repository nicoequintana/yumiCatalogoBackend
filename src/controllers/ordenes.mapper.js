/**
 * Forma de respuesta de una orden.
 *
 * Vive separado del controller por el mismo motivo que `products.mapper.js`: es
 * puro (sin base ni storage) y lo que decide es qué campos SALEN, que es una
 * regla de acceso, no un detalle de la consulta.
 */

/**
 * El costo de una línea, o nada.
 *
 * **`POST /api/ordenes` es PÚBLICO** (checkout de invitado, sin `requireAuth`:
 * solo rate limit por IP) y su 201 devuelve la orden recién creada con sus
 * items. `ItemOrden.costoUnitario` es el snapshot de lo que el negocio PAGA por
 * esa mercadería: devolverlo tal cual le entrega a cualquier comprador anónimo
 * —y de paso a cualquiera que arme el request a mano— el margen de cada
 * producto del catálogo, a un `fetch` de distancia.
 *
 * Es exactamente lo que `camposDePrecio` (`products.mapper.js`) evita en el
 * catálogo: `costo` y `coeficiente` son ADMIN-ONLY. El checkout se salteaba esa
 * regla porque devolvía la fila cruda de Prisma en vez de mapearla.
 *
 * El default de `esAdmin` es `false` a propósito, mismo criterio que en
 * `products.mapper.js`: si alguien suma un llamador nuevo y se olvida de
 * pasarlo, el modo de falla es "falta un dato en el panel", nunca "el costo se
 * publicó".
 */
function campoDeCosto(item, esAdmin) {
  if (!esAdmin) return null;
  return { costoUnitario: item.costoUnitario?.toString() ?? null };
}

/**
 * Mapea una línea de orden a la forma que devuelve la API.
 *
 * Todo lo demás del snapshot (nombre, precio, cantidad) SÍ viaja: es lo que el
 * cliente compró y lo que hace legible una orden aunque el producto cambie o se
 * borre después.
 */
function mapItemOrden(item, { esAdmin = false } = {}) {
  const { costoUnitario: _costo, ...resto } = item;
  return { ...resto, ...campoDeCosto(item, esAdmin) };
}

/**
 * Mapea una orden (con `cliente` e `items` incluidos) a la forma que devuelve
 * la API.
 *
 * ⚠️ `items.map` NO puede recibir el mapper pelado: `.map` pasa el ÍNDICE como
 * segundo argumento y ahí va el objeto de opciones, así que `mapItemOrden` leería
 * `esAdmin` de un número. Mismo pisotón que documenta `mapProducto`.
 */
export function mapOrden(orden, { esAdmin = false } = {}) {
  if (!orden) return orden;
  return {
    ...orden,
    ...(orden.items !== undefined && {
      items: orden.items.map((item) => mapItemOrden(item, { esAdmin })),
    }),
  };
}
