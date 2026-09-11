import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

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

const liberarMock = vi.fn();
const reservarSlotMock = vi.fn();

vi.mock("../lib/colaBcrypt.js", () => ({
  reservarSlot: (...args) => reservarSlotMock(...args),
  estaBajoPresion: () => false,
}));

let resolverHash;
let rechazarHash;
const hashearPasswordMock = vi.fn(
  () =>
    new Promise((resolve, reject) => {
      resolverHash = resolve;
      rechazarHash = reject;
    }),
);

vi.mock("../lib/passwords.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, hashearPassword: (...args) => hashearPasswordMock(...args) };
});

const { login } = await import("./auth.controller.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/api/auth/login", login);
  app.use(manejadorDeErrores);
  return app;
}

async function agotarMicrotareas() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
  reservarSlotMock.mockReset();
  liberarMock.mockClear();
  reservarSlotMock.mockResolvedValue(liberarMock);
  hashearPasswordMock.mockClear();
  resolverHash = null;
  rechazarHash = null;
});

describe("login — el rehash fire-and-forget recibe el slot en vez de correr después de liberarlo", () => {
  it("mantiene el slot ocupado mientras el rehash está en vuelo y lo libera al terminar", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    // Costo 10: por debajo del vigente (11), necesita rehash.
    const hashViejo = bcrypt.hashSync("clave-correcta", 10);
    findUniqueMock.mockResolvedValue({ id: 5, email: "a@b.c", tokenVersion: 0, passwordHash: hashViejo });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "a@b.c", password: "clave-correcta" });

    expect(res.status).toBe(200);
    // La respuesta ya salió pero el rehash sigue pendiente: el slot NO se liberó.
    expect(liberarMock).not.toHaveBeenCalled();

    resolverHash("hash-nuevo");
    await agotarMicrotareas();

    expect(liberarMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 5 }, data: { passwordHash: "hash-nuevo" } });
  });

  it("libera el slot exactamente una vez aunque el rehash rechace", async () => {
    const bcrypt = (await import("bcryptjs")).default;
    const hashViejo = bcrypt.hashSync("clave-correcta", 10);
    findUniqueMock.mockResolvedValue({ id: 6, email: "b@b.c", tokenVersion: 0, passwordHash: hashViejo });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "b@b.c", password: "clave-correcta" });

    expect(res.status).toBe(200);
    expect(liberarMock).not.toHaveBeenCalled();

    rechazarHash(new Error("bcrypt explotó"));
    await agotarMicrotareas();

    expect(liberarMock).toHaveBeenCalledTimes(1);
  });

  it("libera el slot enseguida cuando el hash ya está al costo vigente (no hace falta rehash)", async () => {
    const { hashearPassword: hashearReal } = await vi.importActual("../lib/passwords.js");
    const hashVigente = await hashearReal("clave-correcta");
    findUniqueMock.mockResolvedValue({ id: 7, email: "c@b.c", tokenVersion: 0, passwordHash: hashVigente });

    const res = await request(buildApp())
      .post("/api/auth/login")
      .send({ email: "c@b.c", password: "clave-correcta" });

    expect(res.status).toBe(200);
    expect(hashearPasswordMock).not.toHaveBeenCalled();
    expect(liberarMock).toHaveBeenCalledTimes(1);
  });
});
