import { Decimal } from "@prisma/client/runtime/client.js";
import { prisma } from "../lib/prisma.js";
import { normalizarDni, esDniValido } from "../lib/dni.js";
import { subtotalDeItem } from "../lib/dinero.js";
import { generarExportacionSolicitados } from "../lib/exportarProductosSolicitados.js";
import { MAX_ORDENES_HISTORICO } from "./admin.controller.js";
import { logAudit } from "../lib/logAudit.js";
import { logEvento, headersDeEvento } from "../lib/logEvento.js";
import { ESTADOS_ORDEN, ESTADOS_CON_STOCK_TOMADO, listaDeEstados } from "../lib/estadosOrden.js";
import { httpError } from "../lib/httpError.js";
import { escaparLike } from "../lib/escaparLike.js";
import { parsearPaginacion } from "../lib/paginacion.js";
import { esEmailValido } from "../lib/emailValido.js";
import { mapOrden } from "./ordenes.mapper.js";
import { notificarCambioEstado, notificarOrdenCreada } from "../services/notificacionesOrden.service.js";

const MAX_INTENTOS_DNI = 5;

// Topes anti-abuso del checkout público (POST /ordenes no requiere auth, solo
// rate limit por IP): sin ellos un body armado a mano podía crear una orden
// con miles de items o cantidades absurdas. Exportados para los tests.
export const MAX_ITEMS_POR_ORDEN = 100;
export const MAX_CANTIDAD_POR_ITEM = 999;

/**
 * Valida los campos requeridos del body de creación de orden (checkout de
 * invitado): dni/nombre/telefono/email/items no vacíos. `notas` es el único
 * opcional. Manual validation, sin Zod/Joi — sigue el mismo estilo que
 * `products.controller.js`'s `validarCamposBase`.
 *
 * El email es obligatorio desde que el checkout manda comprobante por correo:
 * sin él, la orden no es notificable ni al crearse ni al cambiar de estado.
 * La columna `Cliente.email` sigue siendo nullable — hay clientes históricos
 * anteriores a esta regla —, así que la obligatoriedad la impone la API.
 */
function validarCamposBase({ dni, nombre, telefono, email, items }) {
  if (typeof dni !== "string" || dni.trim() === "") {
    throw httpError(400, "El DNI es obligatorio.");
  }
  if (typeof nombre !== "string" || nombre.trim() === "") {
    throw httpError(400, "El nombre es obligatorio.");
  }
  if (typeof telefono !== "string" || telefono.trim() === "") {
    throw httpError(400, "El teléfono es obligatorio.");
  }
  if (typeof email !== "string" || email.trim() === "") {
    throw httpError(400, "El email es obligatorio.");
  }
  if (!esEmailValido(email)) {
    throw httpError(400, "El email no tiene un formato válido.");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, "Debe incluir al menos un producto en la orden.");
  }
  if (items.length > MAX_ITEMS_POR_ORDEN) {
    throw httpError(400, `Una orden no puede tener más de ${MAX_ITEMS_POR_ORDEN} items.`);
  }
}

/**
 * Valida la forma de cada item del body ANTES de tocar la DB: productId y
 * cantidad deben ser enteros positivos. No valida existencia/disponibilidad
 * del producto acá (eso requiere DB, se hace después en `validarProductos`).
 */
function validarFormaItems(items) {
  for (const item of items) {
    const productId = Number(item?.productId);
    const cantidad = Number(item?.cantidad);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw httpError(400, "Cada item debe tener un productId válido.");
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw httpError(400, "Cada item debe tener una cantidad entera mayor a 0.");
    }
    if (cantidad > MAX_CANTIDAD_POR_ITEM) {
      throw httpError(400, `Cada item admite una cantidad máxima de ${MAX_CANTIDAD_POR_ITEM} unidades.`);
    }
  }
}

/**
 * Busca en la DB todos los productos referenciados por los items y valida
 * que: (a) todos existan, (b) estén visibles en el catálogo, (c) no estén
 * agotados. Si CUALQUIER item falla cualquiera de estas condiciones, rechaza
 * el pedido COMPLETO (no hay orden parcial) — por eso esta validación
 * corre antes de abrir la transacción de escritura.
 *
 * Devuelve un snapshot (nombre/precio) de cada producto en el momento exacto
 * de esta llamada — ese snapshot es lo que se persiste en ItemOrden y NUNCA
 * se vuelve a calcular a partir del Product en vivo (invariante permanente:
 * una orden refleja lo que el cliente vio al comprar, aunque el producto
 * después cambie de precio/nombre o se elimine).
 */
async function validarYSnapshotearProductos(items) {
  const ids = items.map((item) => Number(item.productId));
  const productos = await prisma.product.findMany({ where: { id: { in: ids } } });
  const porId = new Map(productos.map((p) => [p.id, p]));

  const itemsConSnapshot = [];
  for (const item of items) {
    const productId = Number(item.productId);
    const cantidad = Number(item.cantidad);
    const producto = porId.get(productId);

    if (!producto) {
      throw httpError(400, `El producto ${productId} no existe.`);
    }
    if (!producto.visibleEnCatalogo) {
      throw httpError(400, `El producto "${producto.nombre}" ya no está disponible.`);
    }
    if (producto.stock <= 0) {
      throw httpError(400, `El producto "${producto.nombre}" está agotado.`);
    }

    itemsConSnapshot.push({
      productId,
      nombreProducto: producto.nombre,
      precioUnitario: producto.precio.toString(),
      // Foto del COSTO, por el mismo motivo que la del precio: sin ella, el
      // margen de esta venta se calcularía más adelante contra el
      // `Product.costo` vigente en ESE momento, y cada aumento de un proveedor
      // reescribiría las ganancias de todos los meses anteriores.
      //
      // `null` cuando el producto todavía no tiene costo cargado. Significa "no
      // se puede calcular el margen de esta línea", NUNCA "margen 0", y quien
      // lo consuma tiene que distinguir los dos casos.
      costoUnitario: producto.costo?.toString() ?? null,
      cantidad,
    });
  }

  return itemsConSnapshot;
}

/**
 * Upsert de Cliente por dni normalizado, con reintento ante colisión P2002.
 *
 * Por qué no alcanza con `prisma.cliente.upsert`: bajo el nivel de
 * aislamiento por defecto, dos requests simultáneos con el mismo DNI nuevo
 * pueden ambos evaluar "no existe" y ambos intentar crear, violando el
 * unique constraint en uno de los dos. Mismo patrón de defensa que
 * `products.controller.js`'s `crear()` usa para colisiones de sku
 * (MAX_INTENTOS_SKU + catch de P2002) — acá aplicado a `Cliente.dni`.
 *
 * Regla de negocio: si el cliente YA existe, se actualizan sus datos de
 * contacto con los valores nuevos (el negocio quiere el dato de contacto más
 * reciente, no el primero que se cargó).
 */
async function upsertClienteConReintento(tx, { dni, nombre, telefono, email }) {
  for (let intento = 1; intento <= MAX_INTENTOS_DNI; intento++) {
    const existente = await tx.cliente.findUnique({ where: { dni } });

    if (existente) {
      return tx.cliente.update({
        where: { dni },
        data: { nombre, telefono, email: email ?? null },
      });
    }

    try {
      return await tx.cliente.create({
        data: { dni, nombre, telefono, email: email ?? null },
      });
    } catch (err) {
      const esColisionDni = err?.code === "P2002" && err.meta?.target?.includes?.("dni");
      if (!esColisionDni || intento === MAX_INTENTOS_DNI) throw err;
      // Otro request ganó la carrera y creó el cliente primero — el próximo
      // loop lo encuentra vía findUnique y sigue por la rama de update().
    }
  }
}

/**
 * POST /api/ordenes — checkout de invitado, PÚBLICO (sin requireAuth). El
 * rate-limiting se aplica a nivel de ruta (ver ordenes.routes.js), no acá.
 *
 * Orden de validación (todo ANTES de cualquier escritura en DB):
 *   1. Campos requeridos presentes (dni/nombre/telefono/items no vacío).
 *   2. DNI normalizado y válido (7-8 dígitos).
 *   3. Forma de cada item (productId/cantidad enteros positivos).
 *   4. Existencia + visibilidad + disponibilidad de cada producto (esto sí
 *      pega contra la DB, es el único paso previo que la requiere).
 * Recién después de pasar las 4 arranca la escritura: upsert de Cliente +
 * creación de Orden/ItemOrden dentro de una misma transacción.
 */
export async function crear(req, res, next) {
  try {
    const { dni, nombre, telefono, email, notas, items } = req.body;

    validarCamposBase({ dni, nombre, telefono, email, items });

    const dniNormalizado = normalizarDni(dni);
    if (!esDniValido(dniNormalizado)) {
      throw httpError(400, "El DNI debe tener 7 u 8 dígitos.");
    }

    validarFormaItems(items);

    const itemsConSnapshot = await validarYSnapshotearProductos(items);

    const orden = await prisma.$transaction(async (tx) => {
      const cliente = await upsertClienteConReintento(tx, {
        dni: dniNormalizado,
        nombre: nombre.trim(),
        telefono: telefono.trim(),
        email: email?.trim() || null,
      });

      return tx.orden.create({
        data: {
          clienteId: cliente.id,
          notas: notas?.trim() || null,
          items: { create: itemsConSnapshot },
        },
        include: { cliente: true, items: true },
      });
    });

    // Fire-and-forget: no se espera (ni se deja que una falla acá tumbe la
    // respuesta ya exitosa). Va sin `productId` a propósito: una orden puede
    // tener varios items, así que el evento es a nivel sitio, no de producto.
    logEvento({ tipo: "ORDEN_CREADA", ...headersDeEvento(req) });

    // Fire-and-forget, mismo criterio que `logEvento` de arriba: la orden ya
    // está creada y la respuesta no puede esperar a Gmail ni fallar por él.
    // `notificarOrdenCreada` no lanza por diseño; el `.catch` está por si un
    // cambio futuro la vuelve capaz de hacerlo — una promesa rechazada sin
    // manejar tumba el proceso en Node.
    // Recibe la fila CRUDA, no la mapeada: las plantillas de correo del aviso
    // interno son las únicas consumidoras legítimas del costo, y nunca salen
    // hacia el comprador.
    notificarOrdenCreada(orden).catch(() => {});

    // Mapeada, y sin `esAdmin`: este endpoint es público y el 201 lo lee el
    // comprador. Ver `campoDeCosto` en `ordenes.mapper.js` — devolver la fila
    // cruda le filtraba `costoUnitario`, o sea el margen del negocio.
    res.status(201).json(mapOrden(orden));
  } catch (err) {
    next(err);
  }
}

/**
 * Construye el `where` de `listar()` a partir de los filtros opcionales de
 * query string: estado (match exacto), rango de fechas sobre `createdAt`
 * (`desde`/`hasta`, ISO), y dni/nombre del cliente (relation filter contra
 * `Cliente`, vía `where.cliente`). Todos combinables.
 *
 * Mismo criterio que `products.controller.js`'s `construirFiltrosListado`:
 * un valor malformado (fecha inválida, estado desconocido) nunca tira
 * 400/500 acá — simplemente esa porción del filtro se ignora.
 */
function construirFiltrosOrdenes(query) {
  const where = {};

  if (query.estado !== undefined && ESTADOS_ORDEN.includes(query.estado)) {
    where.estado = query.estado;
  }

  const rangoFechas = {};
  if (query.desde !== undefined) {
    const desde = new Date(query.desde);
    if (!Number.isNaN(desde.getTime())) rangoFechas.gte = desde;
  }
  if (query.hasta !== undefined) {
    const hasta = new Date(query.hasta);
    if (!Number.isNaN(hasta.getTime())) rangoFechas.lte = hasta;
  }
  if (Object.keys(rangoFechas).length > 0) where.createdAt = rangoFechas;

  const filtroCliente = {};
  if (typeof query.dni === "string" && query.dni !== "") {
    filtroCliente.dni = normalizarDni(query.dni);
  }
  // Sin `mode: "insensitive"` a propósito: el conector mssql de Prisma no lo
  // soporta y la collation por defecto de esta base ya es case-insensitive
  // (mismo criterio que `products.controller.js`'s `construirFiltrosListado`).
  // Los metacaracteres de LIKE se escapan antes del `contains` — ver
  // `lib/escaparLike.js`.
  if (typeof query.nombre === "string" && query.nombre !== "") {
    filtroCliente.nombre = { contains: escaparLike(query.nombre) };
  }
  if (Object.keys(filtroCliente).length > 0) where.cliente = filtroCliente;

  return where;
}

/**
 * GET /api/ordenes — listado paginado para el panel admin, protegido con
 * requireAuth. Filtros combinables por query string (estado/desde/hasta/
 * dni/nombre), orden por createdAt desc (más reciente primero). Incluye
 * `cliente` completo y `_count.items` (NO los items completos): nada en el
 * schema ni en `crear()` limita cuántos items puede tener una orden, así que
 * traer los items completos de hasta `MAX_PAGE_SIZE` órdenes (ver
 * `lib/paginacion.js`) podría inflar
 * el payload del listado sin necesidad real todavía (no hay frontend
 * consumiéndolo en este diff). El detalle línea por línea vive en
 * `obtenerPorId()` — split estándar lista/detalle.
 *
 * Paginación: `parsearPaginacion` de `lib/paginacion.js`, el mismo parser que
 * usan los listados de logs del admin — page/pageSize floored/clamped con
 * defaults sanos.
 */
export async function listar(req, res, next) {
  try {
    const { page, pageSize } = parsearPaginacion(req.query);

    const where = construirFiltrosOrdenes(req.query);

    const [total, ordenes] = await Promise.all([
      prisma.orden.count({ where }),
      prisma.orden.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { cliente: true, _count: { select: { items: true } } },
      }),
    ]);

    // Por `mapOrden` aunque el listado no traiga items: es lo que suma
    // `estadoEtiqueta`, y saltearlo fue exactamente el bug que atrapó el smoke
    // test — la fila cruda de Prisma salía sin etiqueta y el panel caía al
    // respaldo con la clave cruda. `esAdmin: true` porque la ruta está detrás
    // de `requireAuth`.
    res.json({ data: ordenes.map((o) => mapOrden(o, { esAdmin: true })), page, pageSize, total });
  } catch (err) {
    next(err);
  }
}

/**
 * Estado que NO cuenta como producto solicitado.
 *
 * Es una regla distinta de `ESTADOS_FACTURABLES` (`admin.controller.js`) y no
 * hay que confundirlas: aquella responde "¿esto es plata ganada?" y por eso
 * deja afuera también a PENDIENTE. Acá la pregunta es "¿cuánta mercadería me
 * están pidiendo?", y una orden pendiente ES demanda real — todavía no
 * descontó stock, pero alguien la va a querer. La cancelada, en cambio, no es
 * mercadería a preparar ni a reponer: sumarla infla el total y hace comprar de
 * más.
 */
const ESTADO_EXCLUIDO_SOLICITADOS = "CANCELADA";

/**
 * Agrupa por producto todo lo que los clientes vienen pidiendo, a través de
 * TODAS las órdenes (sin filtro de fecha) salvo las canceladas.
 *
 * La calculan las DOS rutas del reporte — la grilla y su exportación a
 * `.xlsx`— porque un Excel que no coincide con la pantalla que lo ofrece es
 * peor que no tener Excel: nadie se entera de que difieren.
 *
 * **La clave de agrupamiento cae al snapshot `nombreProducto` cuando no hay
 * `productId`.** Desde que borrar un producto desliga sus líneas
 * (`onDelete: SetNull`), agrupar por `productId` a secas mete a todos los
 * borrados en la clave `null` y suma sus unidades en una sola fila, bajo el
 * nombre del primero. Sin error y sin aviso. Mismo cuidado que el ranking de
 * `resumenVentas`.
 *
 * Sin filtro de fecha, pero no sin techo: la consulta crece para siempre y se
 * reduce entera en memoria, así que lleva el mismo tope y la misma detección
 * de corte que `clientes-resumen` (`MAX_ORDENES_HISTORICO`, una fila de más
 * para saber si hubo recorte, se conservan las MÁS RECIENTES). Con
 * `recortado: true` los totales son un PISO y la pantalla lo declara.
 *
 * @returns {Promise<{data: object[], historico: {ordenesAnalizadas: number, tope: number, recortado: boolean}}>}
 */
export async function calcularProductosSolicitados() {
  const filas = await prisma.orden.findMany({
    where: { estado: { not: ESTADO_EXCLUIDO_SOLICITADOS } },
    orderBy: { createdAt: "desc" },
    take: MAX_ORDENES_HISTORICO + 1,
    select: {
      id: true,
      items: {
        select: {
          productId: true,
          nombreProducto: true,
          precioUnitario: true,
          cantidad: true,
          // El SKU no está en `ItemOrden` — vive en `Product`, así que sale
          // del join. Un producto borrado no tiene ninguno, y esa fila se
          // reporta sin SKU en vez de inventarle uno.
          product: { select: { sku: true } },
        },
      },
    },
  });

  const recortado = filas.length > MAX_ORDENES_HISTORICO;
  const ordenes = recortado ? filas.slice(0, MAX_ORDENES_HISTORICO) : filas;

  // clave -> { productId, sku, nombre, unidades, facturacion, ordenesVistas }
  const porProducto = new Map();

  for (const orden of ordenes) {
    for (const item of orden.items) {
      // El prefijo evita que el nombre "7" de un producto borrado colisione
      // con el `productId` 7 de uno vivo.
      const clave = item.productId ?? `nombre:${item.nombreProducto}`;

      let acumulado = porProducto.get(clave);
      if (!acumulado) {
        acumulado = {
          productId: item.productId ?? null,
          sku: item.product?.sku ?? null,
          // Las órdenes vienen de la más reciente a la más vieja, así que la
          // primera línea que se ve de un producto trae el nombre snapshot
          // más nuevo — el que la persona reconoce hoy.
          nombre: item.nombreProducto,
          unidades: 0,
          facturacion: new Decimal(0),
          // Un producto puede aparecer en dos líneas de la MISMA orden: el
          // conteo es de órdenes distintas, no de líneas.
          ordenesVistas: new Set(),
        };
        porProducto.set(clave, acumulado);
      }

      acumulado.unidades += item.cantidad;
      acumulado.facturacion = acumulado.facturacion.plus(subtotalDeItem(item));
      acumulado.ordenesVistas.add(orden.id);
    }
  }

  // Desempate por nombre: sin él, dos productos con las mismas unidades pueden
  // salir en distinto orden entre la grilla y el Excel de la misma pantalla.
  const data = [...porProducto.values()]
    .sort((a, b) => b.unidades - a.unidades || a.nombre.localeCompare(b.nombre))
    .map((acumulado) => ({
      productId: acumulado.productId,
      sku: acumulado.sku,
      nombre: acumulado.nombre,
      unidades: acumulado.unidades,
      ordenes: acumulado.ordenesVistas.size,
      facturacion: acumulado.facturacion.toFixed(0),
    }));

  return {
    data,
    historico: {
      ordenesAnalizadas: ordenes.length,
      tope: MAX_ORDENES_HISTORICO,
      recortado,
    },
  };
}

/**
 * GET /api/ordenes/productos-solicitados — la grilla agrupada por producto.
 *
 * Es una LECTURA: sin `logAudit`, mismo criterio que `GET /ordenes`.
 */
export async function listarProductosSolicitados(_req, res, next) {
  try {
    res.json(await calcularProductosSolicitados());
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ordenes/productos-solicitados/export — la MISMA grilla, como
 * `.xlsx` descargable.
 */
export async function exportarProductosSolicitados(_req, res, next) {
  try {
    const { data } = await calcularProductosSolicitados();
    const buffer = await generarExportacionSolicitados(data);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="productos-solicitados.xlsx"');
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ordenes/:id — detalle completo de una orden, protegido con
 * requireAuth. Incluye `cliente` e `items` (con nombreProducto/
 * precioUnitario/cantidad ya snapshoteados en ItemOrden, sin necesidad de
 * volver a joinear contra Product). 404 si el id no es numérico o no existe.
 */
export async function obtenerPorId(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Orden no encontrada.");

    const orden = await prisma.orden.findUnique({
      where: { id },
      include: { cliente: true, items: true },
    });
    if (!orden) throw httpError(404, "Orden no encontrada.");

    // `mapOrden` con `esAdmin: true`: la ruta exige auth, así que el admin ve
    // `costoUnitario` igual que antes — lo que cambia es que la orden sale con
    // su `estadoEtiqueta`.
    res.json(mapOrden(orden, { esAdmin: true }));
  } catch (err) {
    next(err);
  }
}

/**
 * ¿Esta línea perdió su producto?
 *
 * `ItemOrden.productId` es `Int?` con `onDelete: SetNull`: borrar un producto
 * vendido es un flujo soportado a propósito (23/08/2026) y desliga sus líneas
 * en vez de quedar bloqueado por ellas. La orden sigue siendo legible por sus
 * snapshots, pero ya no hay stock que mover.
 *
 * **Un `where: { id: null }` NO es un no-op.** Un id inexistente sí lo es —
 * `updateMany` devuelve `count: 0` y sigue—, pero `null` es otra cosa: el
 * validador de Prisma lo RECHAZA, porque `Product.id` es un `Int` no nulo. Esa
 * excepción se lanza DENTRO de `prisma.$transaction`, así que revierte el cambio
 * de estado entero y el admin recibe un 500 sin camino alternativo: confirmar o
 * cancelar una orden que contiene un producto borrado quedaba imposible.
 */
function esItemDesligado(item) {
  return item.productId === null || item.productId === undefined;
}

/**
 * PATCH /api/ordenes/:id/estado — cambia el estado de una orden, protegido
 * con requireAuth. Validación manual contra los 4 valores válidos.
 *
 * Deliberadamente SIN máquina de estados: cualquier estado válido puede
 * pasar a cualquier otro (incluso ENTREGADA -> PENDIENTE), sin restricciones
 * sobre el estado de origen. Decisión de diseño ya cerrada en el plan del
 * sprint — el admin es humano y puede necesitar corregir errores de carga.
 *
 * Descuento de stock: al entrar a cualquiera de los dos estados de
 * `ESTADOS_CON_STOCK_TOMADO` (EN_PREPARACION, ENTREGADA) sin tener ya el
 * stock tomado, se descuenta `cantidad` del `stock` de cada producto de la
 * orden (transacción única con el cambio de estado). **Quien manda es
 * `stockDescontado`, no el estado**: si la orden ya tenía el flag encendido
 * — porque ya estaba en uno de esos dos estados, porque se guarda de nuevo
 * el mismo, o porque pasa de EN_PREPARACION a ENTREGADA (o al revés) — el
 * stock NO se descuenta de nuevo; ese caso de re-confirmación queda fuera de
 * alcance (decisión de producto: si hace falta corregir, se ajusta el stock
 * a mano desde el form del producto). La ÚNICA re-confirmación que sí vuelve
 * a descontar es la que viene después de una cancelación, porque esa
 * devolvió las unidades y apagó el flag.
 *
 * Todo el descuento es a prueba de concurrencia, y eso pide dos cosas:
 *
 *   1. La ENTRADA a un estado que toma stock se decide con una escritura
 *      guardada (`updateMany` con `stockDescontado: false` como guarda
 *      ENTERA), nunca con una lectura. Adrede SIN condición sobre el estado
 *      de origen: con DOS estados que descuentan, algo como
 *      `estado: { not: "ENTREGADA" }` dejaría que EN_PREPARACION ->
 *      ENTREGADA matcheara la fila y descontara una segunda vez. Bajo READ
 *      COMMITTED dos PATCH simultáneos pueden ambos releer el mismo estado
 *      dentro de su transacción, pero solo uno logra que ese `updateMany`
 *      matchee la fila — el `count` de esa escritura es el árbitro de quién
 *      descuenta. La relectura dentro de la transacción sigue existiendo,
 *      pero solo para los items a descontar y el estado anterior de la
 *      auditoría, jamás para decidir el descuento.
 *   2. La resta la hace la base con `decrement` sobre el valor vigente de la
 *      fila, no el proceso sobre un valor leído antes. SQL Server corre en
 *      READ COMMITTED: un leer-restar-escribir pierde el descuento de la
 *      transacción que haya escrito en el medio.
 *
 * El `gte` del `where` es el que impide dejar el stock en negativo: si no
 * alcanza, no descuenta. Ese caso no se ignora — un segundo `updateMany`,
 * también guardado, apoya la fila en 0, que es el mismo resultado observable
 * que daba el viejo `Math.max(0, ...)`. Y no es silencioso: cada producto que
 * se apoyó en 0 viaja como string en `advertencias` dentro de la respuesta
 * (el frontend actual ignora campos extra) y como objeto en el detalle del
 * AuditLog (`stockInsuficiente`).
 *
 * Incluye `cliente` e `items` en la respuesta (mismo shape que
 * `obtenerPorId()`), no solo los campos escalares de `Orden`: el frontend
 * (`AdminOrdenDetalle.jsx`) reemplaza su estado completo con esta respuesta
 * (`setOrden(actualizado)`) y renderiza `orden.items.reduce(...)` sin guard —
 * devolver la orden "pelada" (sin include) rompía esa pantalla con un
 * `Cannot read properties of undefined (reading 'reduce')` apenas se
 * cambiaba el estado desde la UI (encontrado en Sprint 7 Task 2, E2E
 * scenario 5, verificado en un browser real).
 */
export async function actualizarEstado(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Orden no encontrada.");

    const { estado } = req.body;
    if (!ESTADOS_ORDEN.includes(estado)) {
      throw httpError(400, `estado debe ser uno de: ${ESTADOS_ORDEN.join(", ")}.`);
    }

    const actual = await prisma.orden.findUnique({ where: { id }, include: { items: true } });
    if (!actual) throw httpError(404, "Orden no encontrada.");

    let estadoAnterior = actual.estado;
    let descontoStock = false;
    let liberoStock = false;
    const faltantes = [];
    const liberados = [];

    const orden = await prisma.$transaction(async (tx) => {
      // Relectura dentro de la transacción: aporta los items a descontar y el
      // estado anterior real para la auditoría. La DECISIÓN de descontar NO
      // sale de esta lectura (ver el comentario del bloque de arriba).
      const vigente = await tx.orden.findUnique({ where: { id }, include: { items: true } });
      if (!vigente) throw httpError(404, "Orden no encontrada.");

      estadoAnterior = vigente.estado;

      if (ESTADOS_CON_STOCK_TOMADO.includes(estado)) {
        // Escritura guardada: el árbitro de la transición es el `count` de esta
        // escritura, nunca una relectura. Bajo READ COMMITTED dos PATCH
        // concurrentes releen lo mismo, pero solo uno gana el X lock y obtiene
        // `count: 1`.
        //
        // `stockDescontado: false` es la guarda entera. La condición sobre el
        // estado de origen se sacó al pasar a DOS estados que descuentan: con
        // `estado: { not: "ENTREGADA" }`, la transición EN_PREPARACION ->
        // ENTREGADA —que debe ser un no-op de stock— matchearía y restaría las
        // unidades por segunda vez.
        //
        // La misma escritura enciende el flag, que es lo que le permite a la
        // cancelación saber que esta orden tiene stock tomado sin deducirlo del
        // estado.
        const transicion = await tx.orden.updateMany({
          where: { id, stockDescontado: false },
          data: { estado, stockDescontado: true },
        });
        descontoStock = transicion.count === 1;
      }

      if (estado === "CANCELADA") {
        // Espejo exacto del descuento, y por la misma razón: el árbitro es una
        // ESCRITURA guardada, nunca una lectura. `stockDescontado: true` en el
        // `where` es lo que garantiza que se devuelva una sola vez — una orden
        // que nunca se confirmó no devuelve nada, y cancelar dos veces
        // devuelve una.
        const transicion = await tx.orden.updateMany({
          where: { id, estado: { not: "CANCELADA" }, stockDescontado: true },
          data: { estado, stockDescontado: false },
        });
        liberoStock = transicion.count === 1;
      }

      if (liberoStock) {
        for (const item of vigente.items) {
          if (esItemDesligado(item)) continue;

          // `increment` sobre el valor vigente de la fila, no el proceso sobre
          // uno leído antes: bajo READ COMMITTED un leer-sumar-escribir pierde
          // lo que haya escrito otra transacción en el medio.
          //
          // Sin guarda de tope: no hay un máximo de stock que respetar. Si la
          // fila no está, `updateMany` devuelve `count: 0` y no pasa nada.
          const { count } = await tx.product.updateMany({
            where: { id: item.productId },
            data: { stock: { increment: item.cantidad } },
          });

          // Se anota SOLO lo que la base efectivamente devolvió. Empujar esto
          // sin mirar el `count` hacía que el AuditLog declarara una devolución
          // que nunca ocurrió — y ese registro es la única traza que existe de
          // una devolución, así que una traza que informa algo que no pasó es
          // peor que no tener ninguna.
          if (count === 1) {
            liberados.push({
              productId: item.productId,
              nombreProducto: item.nombreProducto,
              cantidad: item.cantidad,
            });
          }
        }
      }

      if (descontoStock) {
        for (const item of vigente.items) {
          if (esItemDesligado(item)) continue;

          const { count } = await tx.product.updateMany({
            where: { id: item.productId, stock: { gte: item.cantidad } },
            data: { stock: { decrement: item.cantidad } },
          });

          // Ninguna fila alcanzó el `gte`: o el producto ya no existe, o su
          // stock quedó por debajo de lo pedido (ajuste manual, otra orden).
          // En el segundo caso se apoya en 0 en vez de saltearlo en silencio;
          // el `lt` mantiene el guardado, así que una confirmación concurrente
          // que haya repuesto stock en el medio no se pisa con un cero.
          if (count === 0) {
            await tx.product.updateMany({
              where: { id: item.productId, stock: { lt: item.cantidad } },
              data: { stock: 0 },
            });
            // Sobreventa con señal: el faltante no bloquea la confirmación,
            // pero tampoco pasa en silencio — viaja a la respuesta y al
            // AuditLog (ver después de la transacción).
            faltantes.push({
              productId: item.productId,
              nombreProducto: item.nombreProducto,
              cantidadPedida: item.cantidad,
            });
          }
        }
      }

      // Escribe el estado pedido para las transiciones que la escritura
      // guardada no aplicó — PENDIENTE, que no entra en ningún guardado, o un
      // destino que sí lo intenta pero no matchea porque la orden ya tenía
      // `stockDescontado` en el valor que esa guarda necesitaba (es
      // idempotente respecto de lo que ya decidió el `updateMany`
      // correspondiente) — y devuelve la orden con el shape que espera el
      // frontend (cliente + items, igual que obtenerPorId()).
      return tx.orden.update({
        where: { id },
        data: { estado },
        include: { cliente: true, items: true },
      });
    });

    // Solo se audita el cambio de estado (única mutación admin de órdenes).
    // `crear()` NO se audita: es el checkout público de invitado, no una
    // acción de admin — ese flujo ya deja rastro en EventoTrafico.
    logAudit(req, {
      accion: "ACTUALIZAR_ESTADO",
      entidad: "Orden",
      entidadId: id,
      detalle: {
        estadoAnterior,
        estadoNuevo: estado,
        stockDescontado: descontoStock,
        // Solo cuando hubo sobreventa: qué producto, cuánto se pidió y que el
        // stock se apoyó en 0 en vez de descontarse completo.
        ...(faltantes.length > 0 && { stockInsuficiente: faltantes }),
        // Qué se devolvió al cancelar. Se registra con el detalle por producto
        // porque es la única traza de una devolución: si la confirmación se
        // había apoyado en 0 por falta de stock, acá se devuelve la cantidad
        // PEDIDA y no la efectivamente tomada, así que el número puede quedar
        // por encima de la realidad. Es una imprecisión conocida y acotada a
        // ese caso; este registro es lo que la hace rastreable.
        ...(liberados.length > 0 && { stockLiberado: liberados }),
      },
    });

    // `advertencias` viaja solo cuando hubo faltantes; el frontend actual
    // ignora campos extra, así que agregarlo no rompe a ningún consumidor.
    const advertencias = faltantes.map(
      (f) =>
        `Stock insuficiente para "${f.nombreProducto}": se pidieron ${f.cantidadPedida} unidades y el stock se apoyó en 0.`,
    );

    // Notificación al cliente, DESPUÉS de que la transacción commiteó: el
    // estado ya está guardado y un fallo de correo no puede revertirlo.
    //
    // Comparación estricta contra `true`: el default es NO notificar, así que
    // cualquier otro valor (un string, un 1, el campo ausente) se trata como
    // que no se pidió. Un consumidor que no conozca este campo no puede
    // disparar correos por accidente.
    //
    // A diferencia del alta, acá SÍ se espera el resultado: hay una persona
    // en el panel que necesita saber si el cliente se enteró.
    const notificacion =
      req.body?.notificarCliente === true ? await notificarCambioEstado(orden) : undefined;

    res.json({
      ...mapOrden(orden, { esAdmin: true }),
      ...(advertencias.length > 0 && { advertencias }),
      ...(notificacion !== undefined && { notificacion }),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ordenes/estados — los cuatro estados con su etiqueta y si son
 * terminales.
 *
 * Existe para que el frontend NO tenga su propia copia del diccionario de
 * estados: los selects del panel (filtrar órdenes, cambiar el estado de una)
 * arman sus opciones con esto, y las etiquetas de cada fila viajan como
 * `estadoEtiqueta` en la propia orden. Antes eran un espejo manual entre repos
 * que había que tocar de a dos.
 *
 * Es una constante del proceso — no toca la base — pero va detrás de
 * `requireAuth` igual que el resto del recurso: es información del panel.
 */
export function estados(_req, res) {
  res.json({ estados: listaDeEstados() });
}
