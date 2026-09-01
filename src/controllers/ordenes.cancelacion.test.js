import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Liberación de stock al cancelar una orden.
 *
 * La regla en una línea: **una orden devuelve stock al cancelarse solo si lo
 * tenía tomado**, y eso lo dice `Orden.stockDescontado`, no el estado.
 *
 * Por qué una columna y no deducirlo del estado: el diseño del descuento deja
 * fuera de alcance la re-confirmación (`EN_PREPARACION → ENTREGADA →
 * EN_PREPARACION` NO vuelve a descontar), así que "está en un estado que toma
 * stock" no implica "se lo acaban de tomar ahora". Deducirlo devolvería
 * unidades que nunca se sacaron, que es peor que no devolver ninguna.
 *
 * El árbitro de quién libera es una ESCRITURA guardada, igual que en el
 * descuento y por la misma razón: bajo READ COMMITTED dos PATCH concurrentes
 * pueden leer el mismo estado, pero solo uno gana el `updateMany`.
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

const ITEMS = [
  { id: 1, ordenId: 100, productId: 1, nombreProducto: "Termo", precioUnitario: "100.00", cantidad: 2 },
  { id: 2, ordenId: 100, productId: 2, nombreProducto: "Mate", precioUnitario: "50.00", cantidad: 3 },
];

function orden(overrides = {}) {
  return {
    id: 100,
    estado: "EN_PREPARACION",
    stockDescontado: true,
    items: ITEMS,
    ...overrides,
  };
}

function buildReqRes({ params = {}, body = {} } = {}) {
  const req = { params, body, usuario: { id: 1, email: "admin@yima.test" }, originalUrl: "/api/ordenes/100/estado", method: "PATCH" };
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

beforeEach(() => {
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
  productUpdateManyMock.mockResolvedValue({ count: 1 });
  ordenUpdateManyMock.mockResolvedValue({ count: 1 });
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

describe("cancelar una orden libera su stock", () => {
  it("devuelve la cantidad de cada item al stock del producto", async () => {
    ordenFindUniqueMock.mockResolvedValue(orden());
    ordenUpdateMock.mockResolvedValue({ ...orden(), estado: "CANCELADA", stockDescontado: false });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CANCELADA" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    // La suma la hace la base sobre el valor vigente (`increment`), nunca el
    // proceso sobre un valor leído antes.
    expect(productUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { stock: { increment: 2 } },
    });
    expect(productUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 2 },
      data: { stock: { increment: 3 } },
    });
  });

  it("decide quien libera con una ESCRITURA guardada por stockDescontado", async () => {
    ordenFindUniqueMock.mockResolvedValue(orden());
    ordenUpdateMock.mockResolvedValue({ ...orden(), estado: "CANCELADA" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CANCELADA" } });
    await actualizarEstado(req, res, next);

    expect(ordenUpdateManyMock).toHaveBeenCalledWith({
      where: { id: 100, estado: { not: "CANCELADA" }, stockDescontado: true },
      data: { estado: "CANCELADA", stockDescontado: false },
    });
  });

  it("NO devuelve nada si la orden nunca tuvo stock tomado", async () => {
    ordenFindUniqueMock.mockResolvedValue(orden({ estado: "PENDIENTE", stockDescontado: false }));
    // La escritura guardada no matchea: `stockDescontado` es false.
    ordenUpdateManyMock.mockResolvedValue({ count: 0 });
    ordenUpdateMock.mockResolvedValue({ ...orden(), estado: "CANCELADA" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CANCELADA" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(productUpdateManyMock).not.toHaveBeenCalled();
  });

  it("cancelar dos veces devuelve el stock UNA sola vez", async () => {
    ordenFindUniqueMock.mockResolvedValue(orden({ estado: "CANCELADA", stockDescontado: false }));
    // Segunda cancelación: la fila ya está CANCELADA y el flag ya se apagó.
    ordenUpdateManyMock.mockResolvedValue({ count: 0 });
    ordenUpdateMock.mockResolvedValue({ ...orden(), estado: "CANCELADA" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CANCELADA" } });
    await actualizarEstado(req, res, next);

    expect(productUpdateManyMock).not.toHaveBeenCalled();
  });

  it("registra en la auditoria que se libero el stock", async () => {
    ordenFindUniqueMock.mockResolvedValue(orden());
    ordenUpdateMock.mockResolvedValue({ ...orden(), estado: "CANCELADA" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CANCELADA" } });
    await actualizarEstado(req, res, next);

    const detalle = auditCreateMock.mock.calls[0][0].data.detalle;
    expect(JSON.parse(detalle)).toEqual(
      expect.objectContaining({
        estadoNuevo: "CANCELADA",
        stockLiberado: [
          { productId: 1, nombreProducto: "Termo", cantidad: 2 },
          { productId: 2, nombreProducto: "Mate", cantidad: 3 },
        ],
      }),
    );
  });

  it("pasar a un estado que no es CANCELADA no toca el stock", async () => {
    ordenFindUniqueMock.mockResolvedValue(orden());
    // La orden por defecto ya tiene `stockDescontado: true` — EN_PREPARACION es
    // ahora un estado que TOMA stock (ver ESTADOS_CON_STOCK_TOMADO), así que la
    // guarda real de la base no matchea: la fila ya tiene el flag encendido.
    ordenUpdateManyMock.mockResolvedValue({ count: 0 });
    ordenUpdateMock.mockResolvedValue({ ...orden(), estado: "EN_PREPARACION" });

    const { req, res, next } = buildReqRes({
      params: { id: "100" },
      body: { estado: "EN_PREPARACION" },
    });
    await actualizarEstado(req, res, next);

    expect(productUpdateManyMock).not.toHaveBeenCalled();
  });
});

describe("confirmar marca la orden como tenedora del stock", () => {
  it("la escritura guardada que descuenta setea stockDescontado en true", async () => {
    ordenFindUniqueMock.mockResolvedValue(orden({ estado: "PENDIENTE", stockDescontado: false }));
    ordenUpdateMock.mockResolvedValue({ ...orden(), estado: "EN_PREPARACION" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(ordenUpdateManyMock).toHaveBeenCalledWith({
      // `stockDescontado: false` es la guarda ENTERA: la condición sobre el
      // estado de origen se sacó al pasar a DOS estados que descuentan (ver
      // ESTADOS_CON_STOCK_TOMADO) — con `estado: { not: "ENTREGADA" }`,
      // EN_PREPARACION -> ENTREGADA volvería a matchear y descontaría dos veces.
      where: { id: 100, stockDescontado: false },
      data: { estado: "EN_PREPARACION", stockDescontado: true },
    });
  });
});
