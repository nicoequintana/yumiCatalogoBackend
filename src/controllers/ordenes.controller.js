import { prisma } from "../lib/prisma.js";
import { normalizarDni, esDniValido } from "../lib/dni.js";

const DISPONIBILIDAD_AGOTADO = "AGOTADO";
const MAX_INTENTOS_DNI = 5;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

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
    if (producto.disponibilidad === DISPONIBILIDAD_AGOTADO) {
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
 * Emite el evento ORDEN_CREADA en EventoTrafico. Best-effort, nunca debe
 * hacer fallar la creación de la orden ya confirmada — mismo espíritu que
 * `logError.js` (Sprint 1): fire-and-forget, con catch silencioso propio.
 * Escritura directa a Prisma (no HTTP a /api/eventos: ya estamos en el
 * backend).
 */
async function emitirEventoOrdenCreada() {
  try {
    await prisma.eventoTrafico.create({ data: { tipo: "ORDEN_CREADA" } });
  } catch (err) {
    console.error("No se pudo registrar el evento ORDEN_CREADA:", err);
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
    // respuesta ya exitosa).
    emitirEventoOrdenCreada();

    res.status(201).json(orden);
  } catch (err) {
    next(err);
  }
}
