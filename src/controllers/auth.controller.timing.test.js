import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const findUniqueMock = vi.fn();
const compareMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { usuario: { findUnique: (...args) => findUniqueMock(...args) } },
}));

// Se envuelve solo `compare` para poder observarla; el resto de bcryptjs
// (incluido `hashSync`, que el controller usa al cargar el módulo para
// generar el hash señuelo) queda en su implementación real.
vi.mock("bcryptjs", async (importOriginal) => {
  const actual = await importOriginal();
  const real = actual.default ?? actual;
  const wrapper = {
    ...real,
    compare: (...args) => {
      compareMock(...args);
      return real.compare(...args);
    },
  };
  return { ...actual, default: wrapper };
});

const { login } = await import("./auth.controller.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/api/auth/login", login);
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  findUniqueMock.mockReset();
  compareMock.mockReset();
});

describe("login — resistencia a la enumeración de usuarios por tiempo", () => {
  it("ejecuta bcrypt.compare aunque el email no exista, para no responder más rápido", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "no-existe@test.com", password: "cualquiera" });

    expect(res.status).toBe(401);
    expect(compareMock).toHaveBeenCalledTimes(1);
  });

  it("compara contra un hash señuelo, nunca contra un hash de usuario real", async () => {
    findUniqueMock.mockResolvedValue(null);

    await request(buildApp()).post("/api/auth/login").send({ email: "no-existe@test.com", password: "cualquiera" });

    const [, hashUsado] = compareMock.mock.calls[0];
    expect(typeof hashUsado).toBe("string");
    expect(hashUsado).toMatch(/^\$2[aby]\$/);
  });

  it("el hash señuelo nunca valida ninguna contraseña que un atacante pueda adivinar", async () => {
    findUniqueMock.mockResolvedValue(null);
    const candidatos = ["", "dummy", "password", "admin", "123456", "yima"];

    for (const password of candidatos) {
      const res = await request(buildApp()).post("/api/auth/login").send({ email: "no-existe@test.com", password });
      // Password vacío corta antes por validación de campos obligatorios.
      expect([400, 401]).toContain(res.status);
      expect(res.body.token).toBeUndefined();
    }
  });

  it("devuelve el mismo mensaje de error exista o no el email (no filtra la diferencia)", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const passwordHash = await bcrypt.hash("clave-correcta", 10);

    findUniqueMock.mockResolvedValue(null);
    const resInexistente = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "no-existe@test.com", password: "clave-equivocada" });

    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@test.com", passwordHash });
    const resPasswordMala = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "admin@test.com", password: "clave-equivocada" });

    expect(resInexistente.status).toBe(401);
    expect(resPasswordMala.status).toBe(401);
    expect(resInexistente.body).toEqual(resPasswordMala.body);
  });
});
