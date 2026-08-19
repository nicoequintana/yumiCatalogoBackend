import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const findUniqueMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { usuario: { findUnique: (...args) => findUniqueMock(...args) } },
}));

const { default: authRouter } = await import("./auth.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  findUniqueMock.mockReset();
});

describe("POST /api/auth/login", () => {
  it("devuelve un token válido con credenciales correctas", async () => {
    const passwordHash = await bcrypt.hash("clave-correcta", 10);
    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@test.com", passwordHash });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@test.com", password: "clave-correcta" });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");

    const decoded = jwt.verify(res.body.token, "test-secret");
    expect(decoded.sub).toBe(1);
  });

  it("incluye el email del usuario en el payload del token (para la traza de auditoría)", async () => {
    const passwordHash = await bcrypt.hash("clave-correcta", 10);
    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@test.com", passwordHash });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@test.com", password: "clave-correcta" });

    const decoded = jwt.verify(res.body.token, "test-secret");
    expect(decoded.email).toBe("admin@test.com");
  });

  it("nunca incluye el passwordHash en el payload del token", async () => {
    const passwordHash = await bcrypt.hash("clave-correcta", 10);
    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@test.com", passwordHash });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@test.com", password: "clave-correcta" });

    const decoded = jwt.verify(res.body.token, "test-secret");
    expect(decoded.passwordHash).toBeUndefined();
  });

  it("responde 401 con mensaje genérico si el email no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "no-existe@test.com", password: "cualquiera" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Email o contraseña incorrectos." });
  });

  it("responde 401 con mensaje genérico si la contraseña es incorrecta", async () => {
    const passwordHash = await bcrypt.hash("clave-correcta", 10);
    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@test.com", passwordHash });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@test.com", password: "clave-incorrecta" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Email o contraseña incorrectos." });
  });

  it("responde 400 si falta email o password", async () => {
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "admin@test.com" });
    expect(res.status).toBe(400);
  });
});
