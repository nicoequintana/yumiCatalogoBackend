import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

// `POST /api/auth/login` está detrás de un limitador de 8 solicitudes/15min
// con store en memoria por proceso (ver rateLimit.middleware.js), singleton
// de módulo que no se resetea test a test. Esta suite ya hacía exactamente 8
// POST reales antes del `describe` de rehash; sumar tres más pisaba el tope y
// los nuevos tests recibían 429 en vez del status que en realidad prueban.
// Mismo mock que ordenes.routes.test.js — el comportamiento del limitador
// tiene su propia cobertura en rateLimit.middleware.test.js.
vi.mock("../middlewares/rateLimit.middleware.js", () => ({
  crearLimitadorDeVelocidad: () => (_req, _res, next) => next(),
}));

const findUniqueMock = vi.fn();
const updateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    usuario: {
      findUnique: (...args) => findUniqueMock(...args),
      update: (...args) => updateMock(...args),
    },
  },
}));

const reservarSlotMock = vi.fn();
const estaBajoPresionMock = vi.fn(() => false);
vi.mock("../lib/colaBcrypt.js", () => ({
  reservarSlot: (...args) => reservarSlotMock(...args),
  estaBajoPresion: () => estaBajoPresionMock(),
}));

const { default: authRouter } = await import("./auth.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  reservarSlotMock.mockReset();
  reservarSlotMock.mockResolvedValue(() => {});
  estaBajoPresionMock.mockReturnValue(false);
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

  it("incluye tokenVersion del usuario en el payload del token (para la revocación por cambio de contraseña)", async () => {
    const passwordHash = await bcrypt.hash("clave-correcta", 10);
    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@test.com", passwordHash, tokenVersion: 4 });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@test.com", password: "clave-correcta" });

    const decoded = jwt.verify(res.body.token, "test-secret");
    expect(decoded.tokenVersion).toBe(4);
  });

  it("firma el token con una expiración de 24 horas, no de 7 días", async () => {
    const passwordHash = await bcrypt.hash("clave-correcta", 10);
    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@test.com", passwordHash, tokenVersion: 0 });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@test.com", password: "clave-correcta" });

    const decoded = jwt.verify(res.body.token, "test-secret");
    // 24 h = 86400 s. La ventana corta acota la exposición de un token robado
    // que pase inadvertido; la revocación por tokenVersion cubre el cambio de
    // contraseña de forma inmediata.
    expect(decoded.exp - decoded.iat).toBe(24 * 60 * 60);
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

describe("POST /api/auth/login — rehash al entrar", () => {
  it("si el hash guardado es de costo 10, lo regenera con el costo vigente en un login exitoso", async () => {
    const hashViejo = bcrypt.hashSync("secreta", 10);
    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@yima.test", passwordHash: hashViejo, tokenVersion: 0 });
    updateMock.mockResolvedValue({});

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@yima.test", password: "secreta" });

    expect(res.status).toBe(200);
    // El rehash es fire-and-forget: se espera un tick para que corra.
    await new Promise((r) => setTimeout(r, 300));
    expect(updateMock).toHaveBeenCalledTimes(1);
    const { where, data } = updateMock.mock.calls[0][0];
    expect(where).toEqual({ id: 1 });
    expect(bcrypt.getRounds(data.passwordHash)).toBe(11);
  });

  it("si el hash ya tiene el costo vigente, no escribe nada", async () => {
    const hashNuevo = bcrypt.hashSync("secreta", 11);
    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@yima.test", passwordHash: hashNuevo, tokenVersion: 0 });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@yima.test", password: "secreta" });

    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("con la clave incorrecta no re-hashea aunque el hash sea viejo", async () => {
    const hashViejo = bcrypt.hashSync("secreta", 10);
    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@yima.test", passwordHash: hashViejo, tokenVersion: 0 });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@yima.test", password: "otra" });

    expect(res.status).toBe(401);
    await new Promise((r) => setTimeout(r, 300));
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("reserva un slot de la cola ANTES de consultar la base", async () => {
    findUniqueMock.mockResolvedValue(null);
    await request(buildApp()).post("/api/auth/login").send({ email: "x@y.z", password: "p" });
    expect(reservarSlotMock).toHaveBeenCalledTimes(1);
    expect(reservarSlotMock.mock.invocationCallOrder[0]).toBeLessThan(findUniqueMock.mock.invocationCallOrder[0]);
  });

  it("con la cola llena responde 503 CAPACIDAD sin tocar la base", async () => {
    const lleno = new Error("lleno");
    lleno.status = 503;
    lleno.codigo = "CAPACIDAD";
    lleno.retryAfter = 2;
    reservarSlotMock.mockRejectedValue(lleno);
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "x@y.z", password: "p" });
    expect(res.status).toBe(503);
    expect(res.body.codigo).toBe("CAPACIDAD");
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("libera el slot aunque el login falle", async () => {
    const liberar = vi.fn();
    reservarSlotMock.mockResolvedValue(liberar);
    findUniqueMock.mockResolvedValue(null);
    await request(buildApp()).post("/api/auth/login").send({ email: "x@y.z", password: "p" });
    expect(liberar).toHaveBeenCalledTimes(1);
  });

  it("bajo presion NO re-hashea: una clave correcta no puede costar dos operaciones y una incorrecta una", async () => {
    estaBajoPresionMock.mockReturnValue(true);
    findUniqueMock.mockResolvedValue({
      id: 1,
      email: "admin@yima.test",
      passwordHash: bcrypt.hashSync("secreta", 10),
      tokenVersion: 0,
    });
    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@yima.test", password: "secreta" });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(updateMock).not.toHaveBeenCalled();
  });
});
