import { prisma } from "../lib/prisma.js";
import { normalizarDni, esDniValido } from "../lib/dni.js";
import { logAudit } from "../lib/logAudit.js";
import { logEvento, headersDeEvento } from "../lib/logEvento.js";
import { ESTADOS_ORDEN } from "../lib/estadosOrden.js";
import { httpError } from "../lib/httpError.js";
import { parsearPaginacion } from "../lib/paginacion.js";

const MAX_INTENTOS_DNI = 5;

// Topes anti-abuso del checkout público (POST /ordenes no requiere auth, solo
// rate limit por IP): sin ellos un body armado a mano podía crear una orden
// con miles de items o cantidades absurdas. Exportados para los tests.
export const MAX_ITEMS_POR_ORDEN = 100;
export const MAX_CANTIDAD_POR_ITEM = 999;

/**
 * Valida los campos requeridos del body de creación de orden (checkout de
 * invitado): dni/nombre/telefono/items no vacíos. email y notas son
 * opcionales. Manual validation, sin Zod/Joi — sigue el mismo estilo que
 * `products.controller.js`'s `validarCamposBase`.
 */
function validarCamposBase({ dni, nombre, telefono, items }) {
  if (typeof dni !== "string" || dni.trim() === "") {
    throw httpError(400, "El DNI es obligatorio.");
  }
  if (typeof nombre !== "string" || nombre.trim() === "") {
    throw httpError(400, "El nombre es obligatorio.");
  }
  if (typeof telefono !== "string" || telefono.trim() === "") {
    throw httpError(400, "El teléfono es obligatorio.");
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

    validarCamposBase({ dni, nombre, telefono, items });

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

    res.status(201).json(orden);
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
  if (typeof query.nombre === "string" && query.nombre !== "") {
    filtroCliente.nombre = { contains: query.nombre };
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

    res.json({ data: ordenes, page, pageSize, total });
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

    res.json(orden);
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/ordenes/:id/estado — cambia el estado de una orden, protegido
 * con requireAuth. Validación manual contra los 5 valores válidos.
 *
 * Deliberadamente SIN máquina de estados: cualquier estado válido puede
 * pasar a cualquier otro (incluso ENTREGADA -> PENDIENTE), sin restricciones
 * sobre el estado de origen. Decisión de diseño ya cerrada en el plan del
 * sprint — el admin es humano y puede necesitar corregir errores de carga.
 *
 * Descuento de stock: al entrar a CONFIRMADA viniendo de cualquier OTRO
 * estado, se descuenta `cantidad` del `stock` de cada producto de la orden
 * (transacción única con el cambio de estado). Solo pasa una vez por orden —
 * si ya estaba CONFIRMADA y se vuelve a guardar CONFIRMADA (no-op de estado),
 * o si se pasa a un tercer estado y luego de vuelta a CONFIRMADA, el stock NO
 * se descuenta de nuevo; ese caso de re-confirmación queda fuera de alcance
 * (decisión de producto: si hace falta corregir, se ajusta el stock a mano
 * desde el form del producto).
 *
 * Todo el descuento es a prueba de concurrencia, y eso pide dos cosas:
 *
 *   1. La ENTRADA a CONFIRMADA se decide con una escritura guardada
 *      (`updateMany` con `estado: { not: "CONFIRMADA" }`), nunca con una
 *      lectura. Bajo READ COMMITTED dos PATCH simultáneos pueden ambos releer
 *      PENDIENTE dentro de su transacción, pero solo uno logra que ese
 *      `updateMany` matchee la fila — el `count` de esa escritura es el
 *      árbitro de quién descuenta. La relectura dentro de la transacción
 *      sigue existiendo, pero solo para los items a descontar y el estado
 *      anterior de la auditoría, jamás para decidir el descuento.
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
    const faltantes = [];

    const orden = await prisma.$transaction(async (tx) => {
      // Relectura dentro de la transacción: aporta los items a descontar y el
      // estado anterior real para la auditoría. La DECISIÓN de descontar NO
      // sale de esta lectura (ver el comentario del bloque de arriba).
      const vigente = await tx.orden.findUnique({ where: { id }, include: { items: true } });
      if (!vigente) throw httpError(404, "Orden no encontrada.");

      estadoAnterior = vigente.estado;

      if (estado === "CONFIRMADA") {
        // Escritura guardada: solo matchea si la orden todavía NO estaba
        // CONFIRMADA. El `count` es el árbitro de la transición — dos PATCH
        // concurrentes pueden releer PENDIENTE los dos, pero solo uno de los
        // dos consigue `count: 1` y descuenta.
        const transicion = await tx.orden.updateMany({
          where: { id, estado: { not: "CONFIRMADA" } },
          data: { estado },
        });
        descontoStock = transicion.count === 1;
      }

      if (descontoStock) {
        for (const item of vigente.items) {
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

      // Escribe el estado pedido para las transiciones que no pasaron por la
      // escritura guardada (destino no-CONFIRMADA, o re-guardar CONFIRMADA —
      // en ambos casos es idempotente respecto de lo que ya decidió el
      // updateMany) y devuelve la orden con el shape que espera el frontend
      // (cliente + items, igual que obtenerPorId()).
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
      },
    });

    // `advertencias` viaja solo cuando hubo faltantes; el frontend actual
    // ignora campos extra, así que agregarlo no rompe a ningún consumidor.
    const advertencias = faltantes.map(
      (f) =>
        `Stock insuficiente para "${f.nombreProducto}": se pidieron ${f.cantidadPedida} unidades y el stock se apoyó en 0.`,
    );
    res.json(advertencias.length > 0 ? { ...orden, advertencias } : orden);
  } catch (err) {
    next(err);
  }
}
