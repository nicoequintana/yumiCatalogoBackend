import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const findManyMock = vi.fn();
const countMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    errorLog: {
      findMany: (...args) => findManyMock(...args),
      count: (...args) => countMock(...args),
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
});
