import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-admin-con-largo-suficiente-32b";
process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.CORS_ORIGIN = "http://localhost:5173";
process.env.COOKIE_DOMINIO = "";

/*
 * Paridad anti-enumeración (Amenaza 16) a nivel de ROUTER real: limitadores,
 * `exigirOrigen` y error handler de verdad, solo la base y los mails
 * mockeados. El curl contra la base comparó status y cuerpo; acá se comparan
 * también los HEADERS — un `Set-Cookie`, un `RateLimit-*` o un `Retry-After`
 * distinto delataría la cuenta igual que un cuerpo distinto.
 *
 * Los limitadores guardan su estado en la instancia del módulo: cada request
 * a comparar se hace contra un router recién importado (`vi.resetModules`),
 * así los dos arrancan con el mismo balde y `RateLimit-Remaining` es
 * comparable. Los `vi.mock` sobreviven al reset.
 */

const findUniqueMock = vi.fn();
const updateManyMock = vi.fn();
const tokenCreateMock = vi.fn();
const tokenUpdateManyMock = vi.fn();
const tokenDeleteManyMock = vi.fn();
const dispositivoFindFirstMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: { findUnique: (...a) => findUniqueMock(...a), updateMany: (...a) => updateManyMock(...a) },
    tokenCuenta: {
      create: (...a) => tokenCreateMock(...a),
      updateMany: (...a) => tokenUpdateManyMock(...a),
      deleteMany: (...a) => tokenDeleteManyMock(...a),
    },
    dispositivoConocido: { findFirst: (...a) => dispositivoFindFirstMock(...a) },
  },
}));
vi.mock("../services/notificacionesCuenta.service.js", () => ({
  enviarVerificacion: vi.fn().mockResolvedValue(),
  enviarYaTenesCuenta: vi.fn().mockResolvedValue(),
  enviarReset: vi.fn().mockResolvedValue(),
  enviarCodigoAcceso: vi.fn().mockResolvedValue(),
  enviarCambioEmail: vi.fn().mockResolvedValue(),
  enviarAvisoCambioEmail: vi.fn().mockResolvedValue(),
}));
vi.mock("../lib/logError.js", () => ({ logError: vi.fn() }));

const { hashearPassword } = await import("../lib/passwords.js");
const HASH = await hashearPassword("la-clave-verdadera-larga");

const ORIGIN = "http://localhost:5173";

async function appFresca() {
  vi.resetModules();
  const { default: cuentaRouter } = await import("./cuenta.routes.js");
  const { manejadorDeErrores } = await import("../middlewares/errorHandler.js");
  const app = express();
  app.use(express.json());
  app.use("/api/cuenta", cuentaRouter);
  app.use(manejadorDeErrores);
  return app;
}

/** Todo header menos `date` (reloj de pared, no depende de la cuenta). */
function huella(res) {
  const { date: _date, ...headers } = res.headers;
  return { status: res.status, body: res.body, headers };
}

const vaciarFondo = () => new Promise((resolver) => setImmediate(resolver));

const cuentaVerificada = () => ({
  id: 1, email: "juan@gmail.com", passwordHash: HASH, emailVerificado: true,
  verificadaEn: new Date(), bloqueadoHasta: null, tokenVersion: 0, createdAt: new Date(),
});

beforeEach(() => {
  findUniqueMock.mockReset();
  updateManyMock.mockReset().mockResolvedValue({ count: 0 });
  tokenCreateMock.mockReset().mockResolvedValue({ id: 1 });
  tokenUpdateManyMock.mockReset().mockResolvedValue({ count: 0 });
  tokenDeleteManyMock.mockReset().mockResolvedValue({ count: 0 });
  dispositivoFindFirstMock.mockReset().mockResolvedValue(null);
});

async function login(app, email, password) {
  return request(app).post("/api/cuenta/login").set("Origin", ORIGIN).send({ email, password });
}

describe("POST /api/cuenta/login — email inexistente vs contraseña equivocada", () => {
  it("MISMO status, cuerpo y headers (Set-Cookie, RateLimit-*)", async () => {
    findUniqueMock.mockResolvedValue(null);
    const inexistente = await login(await appFresca(), "nadie@gmail.com", "una-clave-cualquiera");
    await vaciarFondo();

    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const equivocada = await login(await appFresca(), "juan@gmail.com", "una-clave-cualquiera");
    await vaciarFondo();

    expect(inexistente.status).toBe(401);
    expect(inexistente.headers["set-cookie"]).toBeUndefined();
    expect(inexistente.headers["ratelimit-remaining"]).toBeDefined();
    expect(huella(equivocada)).toEqual(huella(inexistente));
  });

  it("con el limitador agotado: el MISMO 429, con los mismos headers (Retry-After incluido)", async () => {
    const agotarYProbar = async (email) => {
      const app = await appFresca();
      // Bodies inválidos: cuentan para el balde por IP pero no llegan a bcrypt.
      for (let i = 0; i < 8; i++) await login(app, 1, 1);
      return login(app, email, "una-clave-cualquiera");
    };
    findUniqueMock.mockResolvedValue(null);
    const inexistente = await agotarYProbar("nadie@gmail.com");
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const equivocada = await agotarYProbar("juan@gmail.com");

    expect(inexistente.status).toBe(429);
    expect(inexistente.headers["retry-after"]).toBeDefined();
    expect(huella(equivocada)).toEqual(huella(inexistente));
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

async function olvide(app, email) {
  return request(app).post("/api/cuenta/olvide").set("Origin", ORIGIN).send({ email });
}

describe("POST /api/cuenta/olvide — cuenta existente vs inexistente", () => {
  it("MISMO status, cuerpo y headers (Set-Cookie, RateLimit-*)", async () => {
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const existente = await olvide(await appFresca(), "juan@gmail.com");
    await vi.waitFor(() => expect(tokenCreateMock).toHaveBeenCalled());
    await vaciarFondo();

    findUniqueMock.mockResolvedValue(null);
    const inexistente = await olvide(await appFresca(), "nadie@gmail.com");
    await vaciarFondo();

    expect(existente.status).toBe(200);
    expect(existente.headers["set-cookie"]).toBeUndefined();
    expect(existente.headers["ratelimit-remaining"]).toBeDefined();
    expect(huella(inexistente)).toEqual(huella(existente));
  });

  it("con el limitador por IP agotado: el MISMO 429, con los mismos headers (Retry-After incluido)", async () => {
    const agotarYProbar = async (email) => {
      const app = await appFresca();
      // Emails no string: cuentan para el balde por IP, el de destino los saltea.
      for (let i = 0; i < 5; i++) await olvide(app, 123);
      return olvide(app, email);
    };
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const existente = await agotarYProbar("juan@gmail.com");
    findUniqueMock.mockResolvedValue(null);
    const inexistente = await agotarYProbar("nadie@gmail.com");

    expect(existente.status).toBe(429);
    expect(existente.headers["retry-after"]).toBeDefined();
    expect(huella(inexistente)).toEqual(huella(existente));
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("con el limitador por destino agotado: el MISMO 429 y los mismos headers (sin RateLimit propio, ver limitadoresCuenta.js)", async () => {
    const agotarYProbar = async (email) => {
      const app = await appFresca();
      for (let i = 0; i < 3; i++) await olvide(app, email);
      await vaciarFondo();
      return olvide(app, email);
    };
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const existente = await agotarYProbar("juan@gmail.com");
    findUniqueMock.mockResolvedValue(null);
    const inexistente = await agotarYProbar("nadie@gmail.com");
    await vaciarFondo();

    expect(existente.status).toBe(429);
    expect(huella(inexistente)).toEqual(huella(existente));
  });
});
