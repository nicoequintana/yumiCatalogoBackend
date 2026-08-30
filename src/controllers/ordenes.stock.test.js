import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Tres invariantes del movimiento de stock que la suite no cubría y que, con
 * los mocks de Prisma, solo se pueden fijar por la FORMA de la llamada:
 *
 *   1. El descuento ocurre EXACTAMENTE una vez por confirmación. La guarda es
 *      `stockDescontado: false` en el `where` de la transición.
 *   2. Una línea sin producto (`productId: null`, que es lo que deja
 *      `onDelete: SetNull` al borrar un producto vendido) NUNCA llega a un
 *      `updateMany`: `where: { id: null }` no es un no-op, lo rechaza el
 *      validador de Prisma y revierte la transacción entera.
 *   3. `stockLiberado` del AuditLog solo declara lo que la base efectivamente
 *      devolvió.
 *
 * Los tres modos de falla son silenciosos: nada de esto tira un error visible
 * en el momento en que el dato se rompe.
 */

const ordenFindUniqueMock = vi.fn();
const ordenUpdateMock = vi.fn();
const ordenUpdateManyMock = vi.fn();
const productUpdateManyMock = vi.fn();
const auditCreateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    orden: {
      findUnique: (...args) => ordenFindUniqueMock(...args),
      update: (...args) => ordenUpdateMock(...args),
      updateMany: (...args) => ordenUpdateManyMock(...args),
    },
    product: { updateMany: (...args) => productUpdateManyMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    $transaction: (...args) => transactionMock(...args),
  },
}));

const { actualizarEstado } = await import("./ordenes.controller.js");

function orden(overrides = {}) {
  return {
    id: 100,
    estado: "CONFIRMADA",
    stockDescontado: true,
    items: [
      { id: 1, ordenId: 100, productId: 1, nombreProducto: "Termo", precioUnitario: "100", cantidad: 2 },
    ],
    ...overrides,
  };
}

/**
 * La fila de `Orden` que la base "tiene" durante el test.
 *
 * Existe para que `updateMany` se comporte como la base y no como una
 * constante: fijarle el `count` a mano deja los tests afirmando sobre el valor
 * que el propio test eligió, así que el `where` bajo prueba nunca se ejecuta y
 * la regresión que se quiere atrapar pasa en verde.
 */
let filaEnBase = null;

/** Deja una orden en base y hace que `findUnique` la devuelva. */
function montarOrden(overrides = {}) {
  filaEnBase = orden(overrides);
  ordenFindUniqueMock.mockResolvedValue(filaEnBase);
  return filaEnBase;
}

/**
 * Evalúa el `where` que recibió `updateMany` contra la fila en base.
 *
 * Solo entiende lo que estas transiciones usan: igualdad y `{ not }`. Es a
 * propósito — un evaluador genérico de filtros de Prisma sería más código que
 * el controller que testea, y cualquier operador nuevo tiene que romper acá de
 * forma visible en vez de matchear por defecto.
 */
function matchea(where) {
  return Object.entries(where).every(([campo, condicion]) => {
    const valor = filaEnBase[campo];
    if (condicion !== null && typeof condicion === "object") {
      if ("not" in condicion) return valor !== condicion.not;
      throw new Error(`El where usa un operador que este test no evalúa: ${JSON.stringify(condicion)}`);
    }
    return valor === condicion;
  });
}

function buildReqRes({ params = {}, body = {} } = {}) {
  const req = {
    params,
    body,
    usuario: { id: 1, email: "admin@yima.test" },
    originalUrl: "/api/ordenes/100/estado",
    method: "PATCH",
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return { req, res, next: vi.fn() };
}

/** El detalle que `logAudit` serializó en el único renglón de auditoría. */
function detalleAuditado() {
  return JSON.parse(auditCreateMock.mock.calls[0][0].data.detalle);
}

beforeEach(() => {
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
  productUpdateManyMock.mockResolvedValue({ count: 1 });
  // La escritura guardada se resuelve como en la base: matchea o no según el
  // `where` REAL que emite el controller, y aplica el `data` si matcheó.
  ordenUpdateManyMock.mockImplementation(async ({ where, data }) => {
    if (!matchea(where)) return { count: 0 };
    filaEnBase = { ...filaEnBase, ...data };
    return { count: 1 };
  });
  ordenUpdateMock.mockResolvedValue(orden());
  filaEnBase = orden();
  transactionMock.mockImplementation(async (cb) =>
    cb({
      orden: {
        findUnique: (...args) => ordenFindUniqueMock(...args),
        update: (...args) => ordenUpdateMock(...args),
        updateMany: (...args) => ordenUpdateManyMock(...args),
      },
      product: { updateMany: (...args) => productUpdateManyMock(...args) },
    }),
  );
});

describe("el descuento de stock ocurre exactamente una vez", () => {
  it("la transición a CONFIRMADA exige stockDescontado: false", async () => {
    montarOrden({ estado: "PENDIENTE", stockDescontado: false });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    // Sin esta condición, una orden EN_PREPARACION/ENTREGADA —que YA tiene el
    // stock tomado— también cumple `estado != CONFIRMADA`, gana el `count: 1` y
    // se le vuelve a restar el stock al catálogo. Sin error y sin aviso.
    expect(ordenUpdateManyMock.mock.calls[0][0].where).toEqual({
      id: 100,
      estado: { not: "CONFIRMADA" },
      stockDescontado: false,
    });
  });

  it("re-confirmar una orden EN_PREPARACION no vuelve a descontar", async () => {
    // La orden ya tiene el stock tomado, así que la guarda NO matchea. El
    // `count: 0` lo produce el `where` real, no una constante del test: si
    // alguien saca `stockDescontado: false` del controller, este `updateMany`
    // matchea, descuenta, y el test se pone en rojo.
    montarOrden({ estado: "EN_PREPARACION", stockDescontado: true });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(productUpdateManyMock).not.toHaveBeenCalled();
    expect(detalleAuditado().stockDescontado).toBe(false);
  });

  it("confirmar DESPUÉS de cancelar sí vuelve a descontar", async () => {
    // Cancelar apagó el flag y ya devolvió las unidades, así que esta
    // confirmación necesita volver a tomarlas. Es la única re-confirmación que
    // debe descontar, y la guarda no puede romperla.
    montarOrden({ estado: "CANCELADA", stockDescontado: false });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
    await actualizarEstado(req, res, next);

    expect(productUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 1, stock: { gte: 2 } },
      data: { stock: { decrement: 2 } },
    });
  });
});

describe("una línea sin producto no llega nunca a la base", () => {
  const ITEMS_MIXTOS = [
    { id: 1, ordenId: 100, productId: null, nombreProducto: "Producto borrado", precioUnitario: "100", cantidad: 2 },
    { id: 2, ordenId: 100, productId: 5, nombreProducto: "Mate", precioUnitario: "50", cantidad: 3 },
  ];

  it("confirmar una orden con un producto borrado no emite un where con id null", async () => {
    montarOrden({ estado: "PENDIENTE", stockDescontado: false, items: ITEMS_MIXTOS });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
    await actualizarEstado(req, res, next);

    // El modo de falla real: `where: { id: null }` lo rechaza el validador de
    // Prisma (`Product.id` es un Int no nulo) DENTRO de `$transaction`, así que
    // revierte el cambio de estado y el admin recibe un 500 sin salida.
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    for (const [args] of productUpdateManyMock.mock.calls) {
      expect(args.where.id).not.toBeNull();
      expect(args.where.id).toBeDefined();
    }
    // La línea viva sí se descuenta: saltear la desligada no puede saltear el resto.
    expect(productUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 5, stock: { gte: 3 } },
      data: { stock: { decrement: 3 } },
    });
  });

  it("cancelar una orden con un producto borrado no emite un where con id null", async () => {
    montarOrden({ estado: "CONFIRMADA", stockDescontado: true, items: ITEMS_MIXTOS });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CANCELADA" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(productUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(productUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { stock: { increment: 3 } },
    });
    // Tampoco se inventa una devolución para la línea que ya no tiene producto.
    expect(detalleAuditado().stockLiberado).toEqual([
      { productId: 5, nombreProducto: "Mate", cantidad: 3 },
    ]);
  });
});

describe("la auditoría solo declara devoluciones que ocurrieron", () => {
  it("no registra stockLiberado si el increment no matcheó ninguna fila", async () => {
    montarOrden();
    // La fila del producto ya no está: el `updateMany` no toca nada.
    productUpdateManyMock.mockResolvedValue({ count: 0 });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CANCELADA" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    // Ese registro es la ÚNICA traza de una devolución: una que informa algo que
    // no pasó es peor que no tener ninguna.
    expect(detalleAuditado().stockLiberado).toBeUndefined();
  });
});
