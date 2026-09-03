import { totalDeItems } from "../lib/dinero.js";
import { etiquetaDeEstado } from "../lib/estadosOrden.js";
import { urlDeFoto } from "./products.mapper.js";

/**
 * Forma de respuesta de una orden.
 *
 * Vive separado del controller por el mismo motivo que `products.mapper.js`: es
 * puro (sin base ni storage) y lo que decide es qué campos SALEN, que es una
 * regla de acceso, no un detalle de la consulta.
 *
 * Los `include` de Prisma viven ACÁ, al lado del mapper que los interpreta, por
 * el mismo criterio que `LIST_SELECT` en `products.mapper.js`: tenerlos en el
 * controller fue exactamente cómo entró el `orden: true` fantasma que pasó 1098
 * tests en verde y produjo un 500 en el primer request real.
 */

/**
 * Cuántas líneas viajan en el `resumen` del listado.
 *
 * ⚠️ **El tope va acá, JAMÁS como un `take` en el `include` de la query.** Con
 * un `take: 5`, `totalDeItems` sumaría 5 de N líneas y publicaría un monto
 * MENOR que el real — sin error, sin aviso y sin nada que lo delate. El
 * `resumen` es un vistazo; el que tiene que ser exacto es el `total`.
 *
 * `cantidadItems` es lo que vuelve honesto al tope: cuando supera al largo del
 * resumen, la UI cierra con "y N producto(s) más" en vez de mentir por omisión.
 */
export const MAX_ITEMS_RESUMEN = 5;

/**
 * El `include` del LISTADO de órdenes.
 *
 * `cliente` va COMPLETO y no recortado a propósito: `DialogoNotificarEstado`
 * decide si se puede avisar con `Boolean(cliente.email)`, así que un
 * `select: { nombre: true }` dejaría a todos los clientes sin notificar.
 *
 * De `items` solo se traen las tres columnas que alimentan `total` y `resumen`
 * — nunca la fila entera: el listado no emite las líneas y no tiene por qué
 * leer de la base lo que no va a publicar.
 */
export const LISTADO_ORDEN_INCLUDE = {
  cliente: true,
  items: { select: { nombreProducto: true, precioUnitario: true, cantidad: true } },
};

/**
 * El `include` del DETALLE de una orden (y de la respuesta del cambio de estado).
 *
 * ⚠️ **Lo usan DOS caminos y tienen que compartir esta constante**:
 * `obtenerPorId()` y el `tx.orden.update` final de `actualizarEstado()`. Si
 * divergen, el panel muestra las miniaturas al abrir la orden y las PIERDE al
 * cambiarle el estado — porque el detalle hace `setOrden(respuesta)`. Sin
 * error, sin test rojo. Hay un test que lo fija por identidad contra esta
 * constante.
 *
 * ⚠️ **`select` anidado, NUNCA `product: true`.** `include` trae siempre todas
 * las columnas escalares, y la fila de `Product` lleva `costo` y `coeficiente`,
 * que son ADMIN-ONLY. La relación se llama `product` (en inglés) en el schema.
 */
export const DETALLE_ORDEN_INCLUDE = {
  cliente: true,
  items: {
    include: {
      product: {
        select: { fotos: { select: { url: true }, orderBy: { orden: "asc" }, take: 1 } },
      },
    },
  },
};

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
  const { costoUnitario: _costo, product, ...resto } = item;
  return {
    ...resto,
    // `product` se destructura FUERA del spread, y eso es seguridad, no
    // prolijidad: la fila de `Product` lleva `costo` y `coeficiente`, y este
    // mismo mapper sirve al 201 de `POST /api/ordenes`, que es PÚBLICO. La
    // query del detalle ya usa un `select` mínimo, pero el mapper es la ÚLTIMA
    // línea: el día que alguien ensanche ese select "para mostrar el stock", un
    // spread ciego se lo entregaría al comprador anónimo.
    //
    // La clave se emite SOLO cuando el llamador joineó el producto. Ausente
    // significa "no pregunté" (el checkout público usa `items: true` a secas);
    // `null` significa "pregunté y no hay portada" — producto borrado
    // (`onDelete: SetNull` ⇒ `product: null`) o producto sin fotos.
    ...(product !== undefined && {
      fotoPortada: product?.fotos?.[0] ? urlDeFoto(product.fotos[0]) : null,
    }),
    ...campoDeCosto(item, esAdmin),
  };
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
    // La etiqueta legible viaja CON la orden para que el frontend no necesite
    // su propia copia del diccionario de estados (era un espejo manual entre
    // repos). `estado` sigue viajando crudo: es la clave que gobierna la
    // lógica — estilos, transiciones —; la etiqueta es solo texto para humanos.
    ...(orden.estado !== undefined && { estadoEtiqueta: etiquetaDeEstado(orden.estado) }),
    ...(orden.items !== undefined && {
      items: orden.items.map((item) => mapItemOrden(item, { esAdmin })),
    }),
  };
}

/**
 * Mapea una orden a la forma del LISTADO, que es distinta de la del detalle.
 *
 * Espeja el par `mapProductoListado` / `mapProducto` de `products.mapper.js`:
 * el tablero necesita el monto y un vistazo de qué se pidió sin abrir cada
 * orden, pero NO las líneas completas — `precioUnitario` renglón por renglón no
 * tiene por qué viajar a una grilla.
 *
 * **No recibe `esAdmin`, y no es un olvido**: como nunca emite `items`, no hay
 * camino por el que pueda publicar `costoUnitario`. Es una simplificación de
 * seguridad, no una omisión.
 *
 * ⚠️ **Los tres derivados son `null` cuando nadie joineó los ítems, jamás cero.**
 * `totalDeItems` tolera `items` ausente devolviendo `Decimal(0)` (ver
 * `lib/dinero.js`), así que sin esta guarda una orden sin join se publicaría
 * como `$ 0`: un monto inventado, sin error y sin test rojo. Mismo criterio que
 * `costoDeItem`, que devuelve `null` y jamás `Decimal(0)` — `null` es "no se
 * puede saber", cero es un dato.
 */
export function mapOrdenListado(orden) {
  if (!orden) return orden;

  // `items` se destructura fuera del spread para que las líneas no viajen, y
  // `_count` porque `cantidadItems` lo reemplaza.
  const { items, _count: _descartado, ...resto } = orden;

  const derivados =
    items === undefined
      ? { cantidadItems: null, total: null, resumen: null }
      : {
          cantidadItems: items.length,
          total: totalDeItems(items).toFixed(0),
          resumen: items.slice(0, MAX_ITEMS_RESUMEN).map((item) => ({
            nombreProducto: item.nombreProducto,
            cantidad: item.cantidad,
          })),
        };

  return {
    ...resto,
    ...(orden.estado !== undefined && { estadoEtiqueta: etiquetaDeEstado(orden.estado) }),
    ...derivados,
  };
}
