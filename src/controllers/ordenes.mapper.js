import { totalDeItems } from "../lib/dinero.js";
import { etiquetaDeEstado } from "../lib/estadosOrden.js";
import { urlDeFoto } from "../lib/fotos.js";

/**
 * Forma de respuesta de una orden.
 *
 * Vive separado del controller por el mismo motivo que `products.mapper.js`: es
 * puro (sin base ni storage) y lo que decide es qué campos SALEN, que es una
 * regla de acceso, no un detalle de la consulta.
 *
 * Los `include` de Prisma viven ACÁ, al lado del mapper que los interpreta —
 * tenerlos en el controller fue exactamente cómo entró el `orden: true`
 * fantasma que pasó 1098 tests en verde y produjo un 500 en el primer request
 * real.
 *
 * Desde la Parte 3 (cuentas de cliente) este archivo tiene DOS familias de
 * mapper:
 *   - `mapOrden` / `mapOrdenListado`: superficie ADMIN. Resuelven el contacto
 *     desde `cuentaCliente ?? cliente`, campo por campo, y siguen emitiendo
 *     `costoUnitario` cuando `esAdmin`.
 *   - `mapOrdenCuenta` / `mapOrdenCuentaListado`: superficie del COMPRADOR
 *     logueado ("Mis pedidos" y el 201 del checkout con sesión). Invariante
 *     permanente: NUNCA emiten `cliente`, `cuentaCliente`, `clienteId` ni
 *     `cuentaClienteId` — ver el docstring de cada una.
 */

export const MAX_ITEMS_RESUMEN = 5;

/** El `select` de `cuentaCliente` en cualquier include de la superficie admin
 * o de "Mis pedidos". SIEMPRE explícito, NUNCA `cuentaCliente: true`: la fila
 * completa lleva `passwordHash`, `tokenVersion`, `intentosFallidos` — datos de
 * autenticación que ningún consumidor de una orden necesita leer. */
const CUENTA_CLIENTE_SELECT = { id: true, nombre: true, telefono: true, email: true };

/**
 * El `include` del LISTADO de órdenes (superficie ADMIN).
 *
 * `cliente` va COMPLETO a propósito: `DialogoNotificarEstado` decide si se
 * puede avisar con `Boolean(cliente.email)` — con un `select` recortado,
 * mapOrden ya no tendría con qué resolver el contacto si la cuenta también
 * tiene huecos. `cuentaCliente` es lo que suma la decisión 8: el contacto de
 * una orden con cuenta se resuelve desde ahí, no desde `Cliente`.
 */
export const LISTADO_ORDEN_INCLUDE = {
  cliente: true,
  cuentaCliente: { select: CUENTA_CLIENTE_SELECT },
  items: { select: { nombreProducto: true, precioUnitario: true, cantidad: true } },
};

/**
 * El `include` del DETALLE de una orden (y de la respuesta del cambio de
 * estado) — superficie ADMIN.
 *
 * ⚠️ Lo usan DOS caminos y tienen que compartir esta constante:
 * `obtenerPorId()` y el `tx.orden.update` final de `actualizarEstado()`. Hay
 * un test que lo fija por identidad contra esta constante — no romperlo.
 */
export const DETALLE_ORDEN_INCLUDE = {
  cliente: true,
  cuentaCliente: { select: CUENTA_CLIENTE_SELECT },
  items: {
    include: {
      product: {
        select: { fotos: { select: { url: true }, orderBy: { orden: "asc" }, take: 1 } },
      },
    },
  },
};

/**
 * El `include` del DETALLE de una orden para la superficie del COMPRADOR
 * ("Mis pedidos" y el 201/200 del checkout con sesión).
 *
 * ⚠️ SIN `cliente` y SIN `cuentaCliente` — a diferencia del de arriba. No es
 * un recorte de performance: es lo que hace estructuralmente imposible que
 * `mapOrdenCuenta` filtre el contacto de nadie, porque la fila que Prisma
 * devuelve ni siquiera lo tiene. Ver Amenaza 6/7 de la spec.
 */
export const DETALLE_ORDEN_CUENTA_INCLUDE = {
  items: {
    include: {
      product: {
        select: { fotos: { select: { url: true }, orderBy: { orden: "asc" }, take: 1 } },
      },
    },
  },
};

/** El `include` del LISTADO de "Mis pedidos" — mismo criterio que el de
 * arriba, sin `cliente` ni `cuentaCliente`. */
export const LISTADO_ORDEN_CUENTA_INCLUDE = {
  items: { select: { nombreProducto: true, precioUnitario: true, cantidad: true } },
};

/**
 * El `cliente` que emiten `mapOrden`/`mapOrdenListado` (superficie ADMIN).
 *
 * Decisiones 8 y 12 de la spec: el contacto de una orden con cuenta se
 * resuelve desde `CuentaCliente`, CAMPO POR CAMPO con `??` — una cuenta puede
 * tener el email pero todavía no el teléfono (recién se registró, no pasó por
 * `/cuenta/completar`), y ese hueco no tiene por qué tapar el teléfono que SÍ
 * hay en `Cliente`. El `dni` es la EXCEPCIÓN y viaja siempre del `Cliente`:
 * es la identidad COMERCIAL, y `CuentaCliente.dni` es nullable — puede no
 * coincidir con el de una compra de invitado anterior a la cuenta.
 */
function resolverCliente(cliente, cuentaCliente) {
  if (!cliente || !cuentaCliente) return cliente;
  return {
    ...cliente,
    nombre: cuentaCliente.nombre ?? cliente.nombre,
    telefono: cuentaCliente.telefono ?? cliente.telefono,
    email: cuentaCliente.email ?? cliente.email,
  };
}

/**
 * A quién y con qué nombre se le escribe sobre una orden. La consume
 * `notificacionesOrden.service.js`.
 *
 * A diferencia de `resolverCliente`, acá la preferencia es de OBJETO
 * COMPLETO (`cuentaCliente ?? cliente`), no campo por campo: mezclar el
 * nombre de una fuente con el email de otra podría mandarle "Hola María" a
 * la casilla de Juan. Si hay cuenta, se confía en ella entera; si no, se cae
 * entera a `Cliente`.
 */
export function contactoDeOrden(orden) {
  const fuente = orden.cuentaCliente ?? orden.cliente ?? {};
  return {
    nombre: fuente.nombre ?? null,
    email: fuente.email ?? null,
    telefono: fuente.telefono ?? null,
  };
}

/**
 * El costo de una línea, o nada. `POST /api/ordenes` es público (o requiere
 * sesión de CLIENTE, nunca de admin) y su 201 devuelve la orden recién creada
 * con sus items — `ItemOrden.costoUnitario` es el margen del negocio y no
 * puede viajar a ningún comprador. Default de `esAdmin` en `false` a
 * propósito: un llamador nuevo que se olvide de pasarlo falla como "falta un
 * dato en el panel", nunca como "el costo se publicó".
 */
function campoDeCosto(item, esAdmin) {
  if (!esAdmin) return null;
  return { costoUnitario: item.costoUnitario?.toString() ?? null };
}

/** Mapea una línea de orden. Común a las dos familias de mapper: ninguna de
 * las dos emite `costoUnitario` salvo `esAdmin: true`, y ninguna de las dos
 * lo recibe desde la superficie del comprador. */
function mapItemOrden(item, { esAdmin = false } = {}) {
  const { costoUnitario: _costo, product, ...resto } = item;
  return {
    ...resto,
    ...(product !== undefined && {
      fotoPortada: product?.fotos?.[0] ? urlDeFoto(product.fotos[0]) : null,
    }),
    ...campoDeCosto(item, esAdmin),
  };
}

/**
 * Mapea una orden a la forma ADMIN. `cuentaCliente` se destructura FUERA del
 * spread — nunca viaja crudo — y lo que se emite en su lugar es el `cliente`
 * YA RESUELTO por `resolverCliente`.
 *
 * ⚠️ `items.map` no puede recibir el mapper pelado: `.map` pasa el ÍNDICE
 * como segundo argumento.
 */
export function mapOrden(orden, { esAdmin = false } = {}) {
  if (!orden) return orden;
  const { cuentaCliente, ...resto } = orden;
  return {
    ...resto,
    ...(orden.cliente !== undefined && { cliente: resolverCliente(orden.cliente, cuentaCliente) }),
    ...(orden.estado !== undefined && { estadoEtiqueta: etiquetaDeEstado(orden.estado) }),
    ...(orden.items !== undefined && {
      items: orden.items.map((item) => mapItemOrden(item, { esAdmin })),
    }),
  };
}

/** Forma de LISTADO admin — mismo contacto resuelto que `mapOrden`, sin
 * `items` completos (ver `mapOrden` de arriba y el docstring original de
 * `MAX_ITEMS_RESUMEN`). No recibe `esAdmin`: nunca emite `items`, así que no
 * hay camino por el que pueda publicar `costoUnitario`. */
export function mapOrdenListado(orden) {
  if (!orden) return orden;
  const { items, cuentaCliente, _count: _descartado, ...resto } = orden;

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
    ...(orden.cliente !== undefined && { cliente: resolverCliente(orden.cliente, cuentaCliente) }),
    ...(orden.estado !== undefined && { estadoEtiqueta: etiquetaDeEstado(orden.estado) }),
    ...derivados,
  };
}

/**
 * Mapea una orden a la forma que ve el COMPRADOR logueado: "Mis pedidos" y el
 * 201/200 de `POST /api/ordenes` con sesión.
 *
 * INVARIANTE PERMANENTE (rango del guard de `costoUnitario`, spec "Modelo de
 * amenazas" #6 y #7): ninguna superficie dirigida al comprador emite la fila
 * `Cliente` ni `CuentaCliente`, ni sus ids. `cliente`, `cuentaCliente`,
 * `clienteId` y `cuentaClienteId` se destructuran FUERA del spread antes de
 * construir la respuesta — nunca alcanza con "no seleccionarlos en el
 * include", porque el día que alguien sume un `include` más ancho en otro
 * punto de la app y reuse este mapper, un spread ciego se los entregaría al
 * propio dueño de la sesión igual (que vería SU contacto, inofensivo) o, si
 * el include llegó mal armado, al de otra orden en el mismo lote.
 */
export function mapOrdenCuenta(orden) {
  if (!orden) return orden;
  const { cliente: _cliente, cuentaCliente: _cuentaCliente, clienteId: _clienteId, cuentaClienteId: _cuentaClienteId, items, ...resto } = orden;
  return {
    ...resto,
    ...(orden.estado !== undefined && { estadoEtiqueta: etiquetaDeEstado(orden.estado) }),
    ...(items !== undefined && {
      items: items.map((item) => mapItemOrden(item, { esAdmin: false })),
    }),
  };
}

/** Forma de LISTADO de "Mis pedidos" — mismo criterio que `mapOrdenCuenta`,
 * sin `items` completos, con `resumen`/`total`/`cantidadItems` como
 * `mapOrdenListado`. */
export function mapOrdenCuentaListado(orden) {
  if (!orden) return orden;
  const { cliente: _cliente, cuentaCliente: _cuentaCliente, clienteId: _clienteId, cuentaClienteId: _cuentaClienteId, items, _count: _descartado, ...resto } = orden;

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
