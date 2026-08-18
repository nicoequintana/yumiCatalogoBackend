import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const clienteFindUniqueMock = vi.fn();
const clienteCreateMock = vi.fn();
const clienteUpdateMock = vi.fn();
const productFindManyMock = vi.fn();
const ordenCreateMock = vi.fn();
const ordenFindManyMock = vi.fn();
const ordenFindUniqueMock = vi.fn();
const ordenUpdateMock = vi.fn();
const ordenCountMock = vi.fn();
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
    orden: {
      create: (...args) => ordenCreateMock(...args),
      findMany: (...args) => ordenFindManyMock(...args),
      findUnique: (...args) => ordenFindUniqueMock(...args),
      update: (...args) => ordenUpdateMock(...args),
      count: (...args) => ordenCountMock(...args),
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

const token = jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  clienteFindUniqueMock.mockReset();
  clienteCreateMock.mockReset();
  clienteUpdateMock.mockReset();
  productFindManyMock.mockReset();
  ordenCreateMock.mockReset();
  ordenFindManyMock.mockReset();
  ordenFindUniqueMock.mockReset();
  ordenUpdateMock.mockReset();
  ordenCountMock.mockReset();
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

describe("GET /api/ordenes", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/ordenes");
    expect(res.status).toBe(401);
  });

  it("responde 200 con token y devuelve el listado paginado", async () => {
    ordenFindManyMock.mockResolvedValue([ORDEN]);
    ordenCountMock.mockResolvedValue(1);

    const res = await request(buildApp()).get("/api/ordenes").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
  });
});

describe("GET /api/ordenes/:id", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/ordenes/100");
    expect(res.status).toBe(401);
  });

  it("responde 200 con token y devuelve la orden", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN);

    const res = await request(buildApp()).get("/api/ordenes/100").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(100);
  });

  it("responde 404 si la orden no existe", async () => {
    ordenFindUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/ordenes/999").set("Authorization", authHeader);

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/ordenes/:id/estado", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).patch("/api/ordenes/100/estado").send({ estado: "CONFIRMADA" });
    expect(res.status).toBe(401);
  });

  it("responde 200 con token y actualiza el estado", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN);
    ordenUpdateMock.mockResolvedValue({ ...ORDEN, estado: "CONFIRMADA" });

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "CONFIRMADA" });

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe("CONFIRMADA");
  });

  it("responde 400 si el estado no es válido", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN);

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "INVENTADO" });

    expect(res.status).toBe(400);
  });

  it("permite ENTREGADA -> PENDIENTE sin restricciones de máquina de estados", async () => {
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN, estado: "ENTREGADA" });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN, estado: "PENDIENTE" });

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "PENDIENTE" });

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe("PENDIENTE");
  });
});
