import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.CORS_ORIGIN = "http://localhost:5173";
process.env.COOKIE_DOMINIO = "";

vi.mock("../lib/prisma.js", () => ({
  prisma: { cuentaCliente: { findUnique: vi.fn().mockResolvedValue(null) } },
}));
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

const ORIGIN = "http://localhost:5173";

describe("router /api/cuenta — Parte 2b", () => {
  it("POST /login sin Origin: 403 (exigirOrigen corre ANTES que el handler)", async () => {
    const res = await request(buildApp()).post("/api/cuenta/login").send({ email: "x@gmail.com", password: "y" });
    expect(res.status).toBe(403);
  });

  it("POST /login con Origin llega al handler (401 por credenciales, no 404/403)", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/login")
      .set("Origin", ORIGIN)
      .send({ email: "x@gmail.com", password: "y" });
    expect(res.status).toBe(401);
  });

  it("POST /login/codigo con Origin llega al handler (400/401, no 404/403)", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/login/codigo")
      .set("Origin", ORIGIN)
      .send({ email: "x@gmail.com", codigo: "123456" });
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("POST /login/codigo/reenviar con Origin llega al handler", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/login/codigo/reenviar")
      .set("Origin", ORIGIN)
      .send({ email: "x@gmail.com" });
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("POST /olvide con Origin llega al handler (siempre 200, anti-enumeración)", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/olvide")
      .set("Origin", ORIGIN)
      .send({ email: "x@gmail.com" });
    expect(res.status).toBe(200);
  });

  it("POST /restablecer con Origin llega al handler (400, no 404/403)", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/restablecer")
      .set("Origin", ORIGIN)
      .send({ token: "t", password: "y" });
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(403);
  });

  it("POST /email/confirmar sin sesion llega al handler (es publico, sin 401 de requireCliente)", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/email/confirmar")
      .set("Origin", ORIGIN)
      .send({ token: "t" });
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(401);
  });

  it("GET /api/cuenta sin sesion: 401 SESION_INVALIDA (requireCliente)", async () => {
    const res = await request(buildApp()).get("/api/cuenta");
    expect(res.status).toBe(401);
    expect(res.body.codigo).toBe("SESION_INVALIDA");
  });

  it("PUT /api/cuenta sin sesion: 401 (requireCliente antes que el handler)", async () => {
    const res = await request(buildApp()).put("/api/cuenta").set("Origin", ORIGIN).send({});
    expect(res.status).toBe(401);
  });

  it("POST /api/cuenta/salir sin sesion: 401 (requireCliente antes que el handler)", async () => {
    const res = await request(buildApp()).post("/api/cuenta/salir").set("Origin", ORIGIN);
    expect(res.status).toBe(401);
  });

  it("PUT /api/cuenta/password sin sesion: 401 (requireCliente antes que el handler)", async () => {
    const res = await request(buildApp()).put("/api/cuenta/password").set("Origin", ORIGIN).send({});
    expect(res.status).toBe(401);
  });

  it("PUT /api/cuenta/email sin sesion: 401 (requireCliente antes que el handler)", async () => {
    const res = await request(buildApp()).put("/api/cuenta/email").set("Origin", ORIGIN).send({});
    expect(res.status).toBe(401);
  });
});
