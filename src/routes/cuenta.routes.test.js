import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-admin-con-largo-suficiente-32b";
process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.CORS_ORIGIN = "http://localhost:5173";

vi.mock("../lib/prisma.js", () => ({ prisma: { cuentaCliente: { findUnique: vi.fn() } } }));
vi.mock("../middlewares/rateLimit.middleware.js", () => ({
  crearLimitadorDeVelocidad: () => (_req, _res, next) => next(),
}));

const { manejadorDeErrores } = await import("../middlewares/errorHandler.js");
const { default: cuentaRouter } = await import("./cuenta.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/cuenta", cuentaRouter);
  app.use((_req, res) => res.status(404).json({ error: "Recurso no encontrado." }));
  app.use(manejadorDeErrores);
  return app;
}

describe("router /api/cuenta — cimientos", () => {
  it("existe y responde 404 para una ruta que todavia no esta", async () => {
    const res = await request(buildApp()).get("/api/cuenta/no-existe");
    expect(res.status).toBe(404);
  });

  it("toda mutacion bajo /api/cuenta exige Origin ANTES de cualquier otra cosa", async () => {
    const res = await request(buildApp()).post("/api/cuenta/lo-que-sea").send({});
    expect(res.status).toBe(403);
    expect(res.body.codigo).toBe("ORIGEN_RECHAZADO");
  });

  it("con Origin permitido, una mutacion inexistente llega al 404 (el Origin no la bloqueo)", async () => {
    const res = await request(buildApp()).post("/api/cuenta/lo-que-sea").set("Origin", "http://localhost:5173").send({});
    expect(res.status).toBe(404);
  });
});
