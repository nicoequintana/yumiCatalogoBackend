import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const ordenFindManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    orden: {
      findMany: (...args) => ordenFindManyMock(...args),
    },
  },
}));

const { default: clientesRouter } = await import("./clientes.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/clientes", clientesRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  ordenFindManyMock.mockReset();
});

describe("GET /api/clientes/:dni/ordenes", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/clientes/12345678/ordenes");
    expect(res.status).toBe(401);
  });

  it("responde 200 con token y devuelve el historial de órdenes", async () => {
    ordenFindManyMock.mockResolvedValue([{ id: 1, estado: "ENTREGADA", items: [] }]);

    const res = await request(buildApp())
      .get("/api/clientes/12345678/ordenes")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("devuelve array vacío (no 404) si no hay cliente con ese dni", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/clientes/99999999/ordenes")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("normaliza el dni de la URL antes de consultar", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/clientes/12.345.678/ordenes")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(ordenFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cliente: { dni: "12345678" } } }),
    );
  });
});
