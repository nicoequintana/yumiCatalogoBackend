import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const findManyMock = vi.fn();
const countMock = vi.fn();
const auditFindManyMock = vi.fn();
const auditCountMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    errorLog: {
      findMany: (...args) => findManyMock(...args),
      count: (...args) => countMock(...args),
    },
    auditLog: {
      findMany: (...args) => auditFindManyMock(...args),
      count: (...args) => auditCountMock(...args),
    },
  },
}));

const { default: adminRouter } = await import("./admin.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

const token = jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  findManyMock.mockReset();
  countMock.mockReset();
  auditFindManyMock.mockReset();
  auditCountMock.mockReset();
});

describe("GET /api/admin/error-logs", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/admin/error-logs");
    expect(res.status).toBe(401);
  });

  it("responde 200 con token y devuelve resultados paginados ordenados por createdAt desc", async () => {
    const logs = [
      { id: 2, mensaje: "Error reciente", stack: null, ruta: "/api/products", metodo: "GET", status: 500, createdAt: new Date("2026-01-02") },
      { id: 1, mensaje: "Error viejo", stack: null, ruta: "/api/products", metodo: "GET", status: 500, createdAt: new Date("2026-01-01") },
    ];
    findManyMock.mockResolvedValue(logs);
    countMock.mockResolvedValue(2);

    const res = await request(buildApp()).get("/api/admin/error-logs").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBe(2);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } })
    );
  });

  it("usa page y pageSize de la query string para paginar", async () => {
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    const res = await request(buildApp())
      .get("/api/admin/error-logs?page=2&pageSize=5")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(5);
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, take: 5 })
    );
  });

  it("clampea pageSize por encima del máximo permitido (100)", async () => {
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    const res = await request(buildApp())
      .get("/api/admin/error-logs?pageSize=999999999")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(100);
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it("usa el default si page es fraccionario o no numérico, sin tirar 500", async () => {
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    const res = await request(buildApp())
      .get("/api/admin/error-logs?page=2.5&pageSize=abc")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(20);
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
  });

  it("usa el default si page es negativo o cero", async () => {
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    const res = await request(buildApp())
      .get("/api/admin/error-logs?page=-1&pageSize=0")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(findManyMock).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 20 }));
  });
});

describe("GET /api/admin/audit-logs", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/admin/audit-logs");
    expect(res.status).toBe(401);
  });

  it("responde 200 con token y devuelve resultados paginados ordenados por createdAt desc", async () => {
    const logs = [
      {
        id: 2,
        usuarioId: 1,
        usuarioEmail: "admin@yima.test",
        accion: "ACTUALIZAR",
        entidad: "Producto",
        entidadId: 4,
        detalle: null,
        ruta: "/api/products/4",
        metodo: "PUT",
        ip: "10.0.0.1",
        createdAt: new Date("2026-01-02"),
      },
      {
        id: 1,
        usuarioId: 1,
        usuarioEmail: "admin@yima.test",
        accion: "CREAR",
        entidad: "Categoria",
        entidadId: 2,
        detalle: null,
        ruta: "/api/categorias",
        metodo: "POST",
        ip: "10.0.0.1",
        createdAt: new Date("2026-01-01"),
      },
    ];
    auditFindManyMock.mockResolvedValue(logs);
    auditCountMock.mockResolvedValue(2);

    const res = await request(buildApp()).get("/api/admin/audit-logs").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBe(2);
    expect(auditFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "desc" } }),
    );
  });

  it("usa page y pageSize de la query string para paginar", async () => {
    auditFindManyMock.mockResolvedValue([]);
    auditCountMock.mockResolvedValue(0);

    const res = await request(buildApp())
      .get("/api/admin/audit-logs?page=2&pageSize=5")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(5);
    expect(auditFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
  });

  it("clampea pageSize por encima del máximo permitido (100)", async () => {
    auditFindManyMock.mockResolvedValue([]);
    auditCountMock.mockResolvedValue(0);

    const res = await request(buildApp())
      .get("/api/admin/audit-logs?pageSize=999999999")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(100);
    expect(auditFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it("usa el default si page es fraccionario o no numérico, sin tirar 500", async () => {
    auditFindManyMock.mockResolvedValue([]);
    auditCountMock.mockResolvedValue(0);

    const res = await request(buildApp())
      .get("/api/admin/audit-logs?page=2.5&pageSize=abc")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(20);
    expect(auditFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
  });

  it("filtra por entidad cuando viene en la query string", async () => {
    auditFindManyMock.mockResolvedValue([]);
    auditCountMock.mockResolvedValue(0);

    const res = await request(buildApp())
      .get("/api/admin/audit-logs?entidad=Producto")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(auditFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entidad: "Producto" } }),
    );
    expect(auditCountMock).toHaveBeenCalledWith({ where: { entidad: "Producto" } });
  });

  it("sin filtro de entidad no restringe el where", async () => {
    auditFindManyMock.mockResolvedValue([]);
    auditCountMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/admin/audit-logs").set("Authorization", authHeader);

    expect(auditFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });

  it("ignora una entidad vacía en vez de filtrar por string vacío", async () => {
    auditFindManyMock.mockResolvedValue([]);
    auditCountMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/admin/audit-logs?entidad=").set("Authorization", authHeader);

    expect(auditFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});
