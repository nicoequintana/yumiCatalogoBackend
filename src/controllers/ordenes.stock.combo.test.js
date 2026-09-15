import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

// Estado en memoria de la orden y de los dos productos, para que los mocks de
// `updateMany` puedan EVALUAR el `where` contra la fila real — igual que hace
// `ordenes.stock.test.js` para la guarda de `stockDescontado`.
let ordenFila;
let productos;

const ordenMock = {
  findUnique: vi.fn(() => Promise.resolve(ordenFila)),
  updateMany: vi.fn(({ where, data }) => {
    if (where.id !== ordenFila.id) return Promise.resolve({ count: 0 });
    if (where.stockDescontado !== undefined && where.stockDescontado !== ordenFila.stockDescontado) {
      return Promise.resolve({ count: 0 });
    }
    Object.assign(ordenFila, data);
    return Promise.resolve({ count: 1 });
  }),
  update: vi.fn(() => Promise.resolve(ordenFila)),
};
const productMock = {
  updateMany: vi.fn(({ where, data }) => {
    const producto = productos.find((p) => p.id === where.id);
    if (!producto) return Promise.resolve({ count: 0 });
    if (where.stock?.gte !== undefined && producto.stock < where.stock.gte) {
      return Promise.resolve({ count: 0 });
    }
    if (where.stock?.lt !== undefined && !(producto.stock < where.stock.lt)) {
      return Promise.resolve({ count: 0 });
    }
    if (data.stock?.decrement !== undefined) producto.stock -= data.stock.decrement;
    else if (data.stock?.increment !== undefined) producto.stock += data.stock.increment;
    else if (data.stock !== undefined) producto.stock = data.stock;
    return Promise.resolve({ count: 1 });
  }),
};
const auditCreateMock = vi.fn();
const usuarioFindUniqueMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    orden: {
      findUnique: (...a) => ordenMock.findUnique(...a),
      updateMany: (...a) => ordenMock.updateMany(...a),
      update: (...a) => ordenMock.update(...a),
    },
    product: { updateMany: (...a) => productMock.updateMany(...a) },
    usuario: { findUnique: (...a) => usuarioFindUniqueMock(...a) },
    auditLog: { create: (...a) => auditCreateMock(...a) },
    $transaction: (fn) => fn({ orden: ordenMock, product: productMock }),
  },
}));

vi.mock("../services/notificacionesOrden.service.js", () => ({
  notificarCambioEstado: vi.fn(),
  notificarOrdenCreada: vi.fn(),
}));

const { default: ordenesRouter } = await import("../routes/ordenes.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ordenes", ordenesRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "3650d",
});
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
  productos = [{ id: 9, stock: 10 }];
  // Dos filas del MISMO productId: una suelta (cantidad 1) y una que vino de
  // un combo (cantidad 2, con snapshot de combo).
  ordenFila = {
    id: 1,
    estado: "PENDIENTE",
    stockDescontado: false,
    items: [
      { id: 101, productId: 9, nombreProducto: "Lámpara", precioUnitario: "8500", cantidad: 1, comboId: null },
      { id: 102, productId: 9, nombreProducto: "Lámpara", precioUnitario: "8500", cantidad: 2, comboId: 5, comboNombre: "Kit Living" },
    ],
  };
});

describe("dos filas del mismo productId en una orden (una suelta, una de combo)", () => {
  it("el descuento de stock resta la suma de las DOS filas, no solo una", async () => {
    const res = await request(buildApp())
      .patch("/api/ordenes/1/estado")
      .set("Authorization", authHeader)
      .send({ estado: "EN_PREPARACION" });

    expect(res.status).toBe(200);
    // 1 (suelta) + 2 (combo) = 3 unidades descontadas de un stock de 10.
    expect(productos[0].stock).toBe(7);
  });

  it("cancelar devuelve la suma de las DOS filas", async () => {
    ordenFila.estado = "EN_PREPARACION";
    ordenFila.stockDescontado = true;
    productos[0].stock = 7;

    const res = await request(buildApp())
      .patch("/api/ordenes/1/estado")
      .set("Authorization", authHeader)
      .send({ estado: "CANCELADA" });

    expect(res.status).toBe(200);
    expect(productos[0].stock).toBe(10);
  });
});
