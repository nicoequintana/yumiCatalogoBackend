import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const categoriaMock = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const productCountMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    categoria: {
      findMany: (...args) => categoriaMock.findMany(...args),
      findUnique: (...args) => categoriaMock.findUnique(...args),
      create: (...args) => categoriaMock.create(...args),
      update: (...args) => categoriaMock.update(...args),
      delete: (...args) => categoriaMock.delete(...args),
    },
    product: { count: (...args) => productCountMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
  },
}));

const { default: categoriasRouter } = await import("./categorias.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/categorias", categoriasRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test" }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
});

describe("GET /api/categorias (público)", () => {
  it("responde 200 SIN token — el listado lo consume la página pública /coleccion", async () => {
    categoriaMock.findMany.mockResolvedValue([
      { id: 1, nombre: "Velas", _count: { productos: 3 } },
    ]);

    const res = await request(buildApp()).get("/api/categorias");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 1, nombre: "Velas", cantidadProductos: 3 }]);
  });
});

describe("POST /api/categorias (protegido)", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).post("/api/categorias").send({ nombre: "Velas" });

    expect(res.status).toBe(401);
    expect(categoriaMock.create).not.toHaveBeenCalled();
  });

  it("responde 201 con token válido", async () => {
    categoriaMock.findUnique.mockResolvedValue(null);
    categoriaMock.create.mockResolvedValue({ id: 5, nombre: "Velas", _count: { productos: 0 } });

    const res = await request(buildApp())
      .post("/api/categorias")
      .set("Authorization", authHeader)
      .send({ nombre: "Velas" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 5, nombre: "Velas", cantidadProductos: 0 });
  });
});

describe("PUT /api/categorias/:id (protegido)", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).put("/api/categorias/1").send({ nombre: "Nuevo" });

    expect(res.status).toBe(401);
    expect(categoriaMock.update).not.toHaveBeenCalled();
  });

  it("responde 200 con token válido", async () => {
    categoriaMock.findUnique.mockResolvedValueOnce({ id: 1, nombre: "Velas" });
    categoriaMock.update.mockResolvedValue({ id: 1, nombre: "Aromas", _count: { productos: 2 } });

    const res = await request(buildApp())
      .put("/api/categorias/1")
      .set("Authorization", authHeader)
      .send({ nombre: "Aromas" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 1, nombre: "Aromas", cantidadProductos: 2 });
  });
});

describe("DELETE /api/categorias/:id (protegido)", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).delete("/api/categorias/1");

    expect(res.status).toBe(401);
    expect(categoriaMock.delete).not.toHaveBeenCalled();
  });

  it("responde 200 con token válido", async () => {
    categoriaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Velas" });
    productCountMock.mockResolvedValue(0);
    categoriaMock.delete.mockResolvedValue({ id: 1 });

    const res = await request(buildApp())
      .delete("/api/categorias/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("auditoría de categorías", () => {
  it("registra en AuditLog al crear", async () => {
    categoriaMock.findUnique.mockResolvedValue(null);
    categoriaMock.create.mockResolvedValue({ id: 5, nombre: "Velas", _count: { productos: 0 } });

    await request(buildApp())
      .post("/api/categorias")
      .set("Authorization", authHeader)
      .send({ nombre: "Velas" });

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "CREAR",
        entidad: "Categoria",
        entidadId: 5,
        usuarioEmail: "admin@yima.test",
      }),
    });
  });

  it("registra en AuditLog al actualizar, con el nombre anterior y el nuevo", async () => {
    categoriaMock.findUnique.mockResolvedValueOnce({ id: 1, nombre: "Velas" });
    categoriaMock.update.mockResolvedValue({ id: 1, nombre: "Aromas", _count: { productos: 2 } });

    await request(buildApp())
      .put("/api/categorias/1")
      .set("Authorization", authHeader)
      .send({ nombre: "Aromas" });

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ACTUALIZAR",
        entidad: "Categoria",
        entidadId: 1,
        detalle: JSON.stringify({ nombreAnterior: "Velas", nombreNuevo: "Aromas" }),
      }),
    });
  });

  it("registra en AuditLog al eliminar", async () => {
    categoriaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Velas" });
    productCountMock.mockResolvedValue(0);
    categoriaMock.delete.mockResolvedValue({ id: 1 });

    await request(buildApp()).delete("/api/categorias/1").set("Authorization", authHeader);

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ELIMINAR",
        entidad: "Categoria",
        entidadId: 1,
        detalle: JSON.stringify({ nombre: "Velas" }),
      }),
    });
  });

  it("NO registra nada en AuditLog en el listado (las lecturas no se auditan)", async () => {
    categoriaMock.findMany.mockResolvedValue([]);

    await request(buildApp()).get("/api/categorias");

    expect(auditCreateMock).not.toHaveBeenCalled();
  });
});
