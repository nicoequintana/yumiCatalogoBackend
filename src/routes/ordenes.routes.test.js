import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const clienteFindUniqueMock = vi.fn();
const clienteCreateMock = vi.fn();
const clienteUpdateMock = vi.fn();
const productFindManyMock = vi.fn();
const ordenCreateMock = vi.fn();
const eventoTraficoCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cliente: {
      findUnique: (...args) => clienteFindUniqueMock(...args),
      create: (...args) => clienteCreateMock(...args),
      update: (...args) => clienteUpdateMock(...args),
    },
    product: {
      findMany: (...args) => productFindManyMock(...args),
    },
    eventoTrafico: {
      create: (...args) => eventoTraficoCreateMock(...args),
    },
    $transaction: async (cb) =>
      cb({
        cliente: {
          findUnique: (...args) => clienteFindUniqueMock(...args),
          create: (...args) => clienteCreateMock(...args),
          update: (...args) => clienteUpdateMock(...args),
        },
        orden: { create: (...args) => ordenCreateMock(...args) },
      }),
  },
}));

const { default: ordenesRouter } = await import("./ordenes.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ordenes", ordenesRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

const PRODUCTO_DISPONIBLE = {
  id: 1,
  nombre: "Producto A",
  precio: "100.00",
  visibleEnCatalogo: true,
  disponibilidad: "DISPONIBLE",
};

const CLIENTE = { id: 10, dni: "12345678", nombre: "Juan Perez", telefono: "1122334455", email: null };

const ORDEN = {
  id: 100,
  clienteId: 10,
  estado: "PENDIENTE",
  notas: null,
  cliente: CLIENTE,
  items: [{ id: 1, ordenId: 100, productId: 1, nombreProducto: "Producto A", precioUnitario: "100.00", cantidad: 1 }],
};

beforeEach(() => {
  clienteFindUniqueMock.mockReset();
  clienteCreateMock.mockReset();
  clienteUpdateMock.mockReset();
  productFindManyMock.mockReset();
  ordenCreateMock.mockReset();
  eventoTraficoCreateMock.mockReset();
  eventoTraficoCreateMock.mockResolvedValue({});
});

describe("POST /api/ordenes", () => {
  it("no requiere autenticación (checkout de invitado)", async () => {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN);

    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        items: [{ productId: 1, cantidad: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.cliente).toBeDefined();
    expect(res.body.items).toBeDefined();
  });

  it("responde 400 si falta el body requerido", async () => {
    const res = await request(buildApp()).post("/api/ordenes").send({});
    expect(res.status).toBe(400);
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("responde 400 si el producto no existe", async () => {
    productFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        items: [{ productId: 999, cantidad: 1 }],
      });

    expect(res.status).toBe(400);
  });
});
