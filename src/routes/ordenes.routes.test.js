import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const clienteFindUniqueMock = vi.fn();
const clienteCreateMock = vi.fn();
const clienteUpdateMock = vi.fn();
const productFindManyMock = vi.fn();
const productFindUniqueMock = vi.fn();
const productUpdateMock = vi.fn();
const productUpdateManyMock = vi.fn();
const ordenCreateMock = vi.fn();
const ordenFindManyMock = vi.fn();
const ordenFindUniqueMock = vi.fn();
const ordenUpdateMock = vi.fn();
const ordenUpdateManyMock = vi.fn();
const ordenCountMock = vi.fn();
const eventoTraficoCreateMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: (...args) => auditCreateMock(...args) },
    cliente: {
      findUnique: (...args) => clienteFindUniqueMock(...args),
      create: (...args) => clienteCreateMock(...args),
      update: (...args) => clienteUpdateMock(...args),
    },
    product: {
      findMany: (...args) => productFindManyMock(...args),
      findUnique: (...args) => productFindUniqueMock(...args),
      update: (...args) => productUpdateMock(...args),
      updateMany: (...args) => productUpdateManyMock(...args),
    },
    orden: {
      create: (...args) => ordenCreateMock(...args),
      findMany: (...args) => ordenFindManyMock(...args),
      findUnique: (...args) => ordenFindUniqueMock(...args),
      update: (...args) => ordenUpdateMock(...args),
      updateMany: (...args) => ordenUpdateManyMock(...args),
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
        product: {
          findUnique: (...args) => productFindUniqueMock(...args),
          update: (...args) => productUpdateMock(...args),
          updateMany: (...args) => productUpdateManyMock(...args),
        },
        orden: {
          create: (...args) => ordenCreateMock(...args),
          findUnique: (...args) => ordenFindUniqueMock(...args),
          update: (...args) => ordenUpdateMock(...args),
          updateMany: (...args) => ordenUpdateManyMock(...args),
        },
      }),
  },
}));

const { default: ordenesRouter } = await import("./ordenes.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ordenes", ordenesRouter);
  app.use(manejadorDeErrores);
  return app;
}

const PRODUCTO_DISPONIBLE = {
  id: 1,
  nombre: "Producto A",
  precio: "100.00",
  visibleEnCatalogo: true,
  stock: 10,
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

const token = jwt.sign({ sub: 1, email: "admin@yima.test" }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  auditCreateMock.mockReset();
  auditCreateMock.mockResolvedValue({ id: 1 });
  clienteFindUniqueMock.mockReset();
  clienteCreateMock.mockReset();
  clienteUpdateMock.mockReset();
  productFindManyMock.mockReset();
  productFindUniqueMock.mockReset();
  productUpdateMock.mockReset();
  productUpdateManyMock.mockReset();
  // Por defecto el descuento guardado encuentra la fila y la actualiza.
  productUpdateManyMock.mockResolvedValue({ count: 1 });
  ordenCreateMock.mockReset();
  ordenFindManyMock.mockReset();
  ordenFindUniqueMock.mockReset();
  ordenUpdateMock.mockReset();
  ordenUpdateManyMock.mockReset();
  // Por defecto la escritura guardada de transición matchea la fila (la
  // orden NO estaba CONFIRMADA).
  ordenUpdateManyMock.mockResolvedValue({ count: 1 });
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
    productUpdateManyMock.mockResolvedValue({ count: 1 });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN, estado: "CONFIRMADA" });

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "CONFIRMADA" });

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe("CONFIRMADA");
    // El descuento lo resuelve la base sobre el valor vigente de la fila.
    expect(productUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, stock: { gte: 1 } },
        data: { stock: { decrement: 1 } },
      }),
    );
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

describe("auditoría de órdenes", () => {
  it("registra en AuditLog el cambio de estado, con el estado anterior y el nuevo", async () => {
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN, estado: "PENDIENTE" });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN, estado: "CONFIRMADA" });
    productFindUniqueMock.mockResolvedValue(PRODUCTO_DISPONIBLE);
    productUpdateMock.mockResolvedValue({});

    await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "CONFIRMADA" });

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ACTUALIZAR_ESTADO",
        entidad: "Orden",
        entidadId: 100,
        usuarioEmail: "admin@yima.test",
        detalle: JSON.stringify({
          estadoAnterior: "PENDIENTE",
          estadoNuevo: "CONFIRMADA",
          stockDescontado: true,
        }),
      }),
    });
  });

  it("una confirmación con stock insuficiente devuelve advertencias y registra el faltante en AuditLog", async () => {
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN, estado: "PENDIENTE" });
    // El descuento guardado no matchea (stock quedó por debajo de lo pedido);
    // el segundo updateMany apoya la fila en 0.
    productUpdateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN, estado: "CONFIRMADA" });

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "CONFIRMADA" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(res.body.advertencias).toHaveLength(1);
    expect(res.body.advertencias[0]).toContain("Producto A");

    // El AuditLog recibe el detalle estructurado del faltante, además del
    // cambio de estado.
    const detalle = JSON.parse(auditCreateMock.mock.calls[0][0].data.detalle);
    expect(detalle.estadoNuevo).toBe("CONFIRMADA");
    expect(detalle.stockDescontado).toBe(true);
    expect(detalle.stockInsuficiente).toEqual([
      { productId: 1, nombreProducto: "Producto A", cantidadPedida: 1 },
    ]);
  });

  it("NO registra nada en AuditLog al crear una orden (checkout público, no es acción de admin)", async () => {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN);
    eventoTraficoCreateMock.mockResolvedValue({});

    await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        items: [{ productId: 1, cantidad: 1 }],
      });

    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("emite el evento ORDEN_CREADA al crear una orden", async () => {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN);
    eventoTraficoCreateMock.mockResolvedValue({});

    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        items: [{ productId: 1, cantidad: 1 }],
      });
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(201);
    expect(eventoTraficoCreateMock).toHaveBeenCalledTimes(1);
    expect(eventoTraficoCreateMock.mock.calls[0][0].data).toMatchObject({
      tipo: "ORDEN_CREADA",
    });
  });

  it("responde 201 igual si el insert del evento falla (best-effort)", async () => {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN);
    eventoTraficoCreateMock.mockRejectedValue(new Error("DB caída"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        items: [{ productId: 1, cantidad: 1 }],
      });
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(201);
    spy.mockRestore();
  });

  it("NO registra nada en AuditLog al listar órdenes (las lecturas no se auditan)", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/ordenes").set("Authorization", authHeader);

    expect(auditCreateMock).not.toHaveBeenCalled();
  });
});
