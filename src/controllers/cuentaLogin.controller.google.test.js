import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente-32";
process.env.COOKIE_DOMINIO = "";
process.env.GOOGLE_CLIENT_ID = "client-id-de-prueba";

const verifyIdTokenMock = vi.fn();
// `function`, no una arrow: el controller hace `new OAuth2Client(...)` y
// Vitest 4 no deja construir un mock cuya implementación es una arrow
// (TypeError adentro del try que verifica el token → un 401 que parecía del
// handler). Se devuelve el objeto explícitamente, como haría la librería real.
vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(function OAuth2ClientFalso() {
    return { verifyIdToken: (...a) => verifyIdTokenMock(...a) };
  }),
}));

const findUniqueMock = vi.fn();
const deleteManyMock = vi.fn();
const createCuentaMock = vi.fn();
const findUniqueIdentidadMock = vi.fn();
const createIdentidadMock = vi.fn();
const createDispMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: {
      findUnique: (...a) => findUniqueMock(...a),
      deleteMany: (...a) => deleteManyMock(...a),
      create: (...a) => createCuentaMock(...a),
    },
    identidadGoogle: {
      findUnique: (...a) => findUniqueIdentidadMock(...a),
      create: (...a) => createIdentidadMock(...a),
    },
    dispositivoConocido: { create: (...a) => createDispMock(...a) },
  },
}));

const logErrorMock = vi.fn();
vi.mock("../lib/logError.js", () => ({ logError: (...a) => logErrorMock(...a) }));

const { google } = await import("./cuentaLogin.controller.js");
const { manejadorDeErrores } = await import("../middlewares/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/google", google);
  app.use(manejadorDeErrores);
  return app;
}

const MENSAJE_SOLO_GMAIL = "Con una cuenta de Google del trabajo no podemos continuar. Registrate con el formulario.";

function payload(extra = {}) {
  return { sub: "sub-1", email: "juan@gmail.com", email_verified: true, name: "Juan", ...extra };
}

function conPayload(extra = {}) {
  verifyIdTokenMock.mockResolvedValue({ getPayload: () => payload(extra) });
}

function pedir(body = { credential: "id-token" }) {
  return request(buildApp()).post("/google").send(body);
}

/** Cuenta completa (nombre/telefono/dni cargados): `completar` en false. */
function cuentaCompleta(extra = {}) {
  return { id: 5, email: "juan@gmail.com", tokenVersion: 0, nombre: "Juan", telefono: "1122334455", dni: "12345678", ...extra };
}

function cookies(res) {
  return res.headers["set-cookie"] ?? [];
}

beforeEach(() => {
  [
    verifyIdTokenMock,
    findUniqueMock,
    deleteManyMock,
    createCuentaMock,
    findUniqueIdentidadMock,
    createIdentidadMock,
    createDispMock,
    logErrorMock,
  ].forEach((m) => m.mockReset());
  process.env.GOOGLE_CLIENT_ID = "client-id-de-prueba";
  findUniqueIdentidadMock.mockResolvedValue(null);
  findUniqueMock.mockResolvedValue(null);
  createDispMock.mockResolvedValue({});
  deleteManyMock.mockResolvedValue({ count: 1 });
});

describe("google — puerta de entrada", () => {
  it("sin GOOGLE_CLIENT_ID: 503 GOOGLE_NO_CONFIGURADO y NUNCA llama a Google", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const res = await pedir();
    expect(res.status).toBe(503);
    expect(res.body.codigo).toBe("GOOGLE_NO_CONFIGURADO");
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("sin credential (o no string): 400, sin tocar Google", async () => {
    expect((await pedir({})).status).toBe(400);
    expect((await pedir({ credential: 123 })).status).toBe(400);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("credential absurdamente largo: 401 sin gastar la verificación remota", async () => {
    const res = await pedir({ credential: "a".repeat(8000) });
    expect(res.status).toBe(401);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("verifica contra Google con audience = GOOGLE_CLIENT_ID (nunca decodifica a mano)", async () => {
    conPayload();
    findUniqueIdentidadMock.mockResolvedValue({ cuenta: cuentaCompleta() });
    await pedir({ credential: "id-token" });
    expect(verifyIdTokenMock).toHaveBeenCalledWith({ idToken: "id-token", audience: "client-id-de-prueba" });
  });

  it("token inválido (verifyIdToken lanza): 401 genérico", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("Invalid token signature"));
    const res = await pedir();
    expect(res.status).toBe(401);
    // El motivo real de Google no se le filtra al cliente.
    expect(res.body.error).not.toMatch(/signature/i);
  });

  it("payload vacío o sin email_verified (ausente = false): 401", async () => {
    verifyIdTokenMock.mockResolvedValue({ getPayload: () => null });
    expect((await pedir()).status).toBe(401);

    conPayload({ email_verified: undefined });
    expect((await pedir()).status).toBe(401);

    conPayload({ email_verified: "true" });
    expect((await pedir()).status).toBe(401);
  });

  it("cuenta de Workspace (hd presente): 403 SOLO_GMAIL con el mensaje de la spec", async () => {
    conPayload({ hd: "empresa.com" });
    const res = await pedir();
    expect(res.status).toBe(403);
    expect(res.body.codigo).toBe("SOLO_GMAIL");
    expect(res.body.error).toBe(MENSAJE_SOLO_GMAIL);
    expect(findUniqueIdentidadMock).not.toHaveBeenCalled();
  });

  it("dominio que no es Gmail: 403 SOLO_GMAIL", async () => {
    conPayload({ email: "juan@outlook.com" });
    const res = await pedir();
    expect(res.status).toBe(403);
    expect(res.body.codigo).toBe("SOLO_GMAIL");
  });

  it("googlemail.com es Gmail: pasa la puerta", async () => {
    conPayload({ email: "juan@googlemail.com" });
    findUniqueIdentidadMock.mockResolvedValue({ cuenta: cuentaCompleta({ email: "juan@googlemail.com" }) });
    expect((await pedir()).status).toBe(200);
  });
});

describe("google — resolución de la cuenta", () => {
  it("IdentidadGoogle con ese sub: entra, sin re-sync de email ni escrituras de cuenta", async () => {
    conPayload();
    findUniqueIdentidadMock.mockResolvedValue({ cuenta: cuentaCompleta() });

    const res = await pedir();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, completar: false });
    expect(findUniqueIdentidadMock).toHaveBeenCalledWith({ where: { sub: "sub-1" }, include: { cuenta: true } });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(createCuentaMock).not.toHaveBeenCalled();
    expect(createIdentidadMock).not.toHaveBeenCalled();
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("éxito: cookie de sesión Y dispositivo conocido (Google no manda código por mail)", async () => {
    conPayload();
    findUniqueIdentidadMock.mockResolvedValue({ cuenta: cuentaCompleta() });

    const res = await pedir();

    expect(cookies(res).some((c) => c.startsWith("sesion_cliente="))).toBe(true);
    expect(cookies(res).some((c) => c.startsWith("dispositivo_cliente="))).toBe(true);
    expect(createDispMock).toHaveBeenCalledTimes(1);
  });

  it("cuenta con ese email VERIFICADA y sin Google: se vincula y no se toca nada más", async () => {
    conPayload();
    findUniqueMock.mockResolvedValue({
      id: 5, email: "juan@gmail.com", tokenVersion: 0, emailVerificado: true, verificadaEn: new Date(),
      identidadGoogle: null, nombre: null, telefono: null, dni: null,
    });

    const res = await pedir();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, completar: true });
    expect(createIdentidadMock).toHaveBeenCalledWith({ data: { cuentaClienteId: 5, sub: "sub-1" } });
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(createCuentaMock).not.toHaveBeenCalled();
  });

  it("cuenta NUNCA verificada: se reemplaza — el borrado lleva las guardas en el WHERE", async () => {
    conPayload();
    findUniqueMock.mockResolvedValue({
      id: 5, email: "juan@gmail.com", emailVerificado: false, verificadaEn: null, identidadGoogle: null,
    });
    createCuentaMock.mockResolvedValue(cuentaCompleta({ id: 6, nombre: "Juan", telefono: null, dni: null }));

    const res = await pedir();

    expect(res.status).toBe(200);
    const where = deleteManyMock.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 5, verificadaEn: null, ordenes: { none: {} } });
    expect(createCuentaMock).toHaveBeenCalledTimes(1);
  });

  it("cuenta reasignada por el panel (emailVerificado false pero verificadaEn puesto): 409, NUNCA se borra", async () => {
    conPayload();
    findUniqueMock.mockResolvedValue({
      id: 5, email: "juan@gmail.com", emailVerificado: false, verificadaEn: new Date("2026-01-01"), identidadGoogle: null,
    });

    const res = await pedir();

    expect(res.status).toBe(409);
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(createCuentaMock).not.toHaveBeenCalled();
  });

  it("el borrado no alcanza a nadie (tiene órdenes o corrió otra request): 409, no se crea nada", async () => {
    conPayload();
    findUniqueMock.mockResolvedValue({
      id: 5, email: "juan@gmail.com", emailVerificado: false, verificadaEn: null, identidadGoogle: null,
    });
    deleteManyMock.mockResolvedValue({ count: 0 });

    const res = await pedir();

    expect(res.status).toBe(409);
    expect(createCuentaMock).not.toHaveBeenCalled();
  });

  it("cuenta con ese email y OTRA IdentidadGoogle: 409, sin borrar ni crear", async () => {
    conPayload();
    findUniqueMock.mockResolvedValue({
      id: 5, email: "juan@gmail.com", emailVerificado: true, verificadaEn: new Date(), identidadGoogle: { sub: "otro-sub" },
    });

    const res = await pedir();

    expect(res.status).toBe(409);
    expect(deleteManyMock).not.toHaveBeenCalled();
    expect(createCuentaMock).not.toHaveBeenCalled();
    expect(createIdentidadMock).not.toHaveBeenCalled();
  });

  it("no existe nada: cuenta GOOGLE nacida verificada, con verificadaEn, sin password y con el sub vinculado", async () => {
    conPayload();
    createCuentaMock.mockResolvedValue(cuentaCompleta({ id: 6, nombre: "Juan", telefono: null, dni: null }));

    const res = await pedir();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, completar: true });
    const data = createCuentaMock.mock.calls[0][0].data;
    expect(data).toMatchObject({
      email: "juan@gmail.com",
      origenRegistro: "GOOGLE",
      emailVerificado: true,
      passwordHash: null,
      nombre: "Juan",
    });
    // Google nace verificada: sin `verificadaEn` la purga de 24 h la trataría
    // como un registro abandonado (ver `estaFueraDeVentana`).
    expect(data.verificadaEn).toBeInstanceOf(Date);
    // El `sub` se vincula en el mismo insert: si no, el próximo login por
    // `sub` no encontraría nada y entraría por el camino del email.
    expect(data.identidadGoogle).toEqual({ create: { sub: "sub-1" } });
    expect(createIdentidadMock).not.toHaveBeenCalled();
  });

  it("payload sin name: la cuenta nueva va con nombre null (no con undefined ni cadena vacía)", async () => {
    conPayload({ name: undefined });
    createCuentaMock.mockResolvedValue(cuentaCompleta({ id: 6, nombre: null, telefono: null, dni: null }));

    await pedir();

    expect(createCuentaMock.mock.calls[0][0].data.nombre).toBeNull();
  });

  it("el email se normaliza antes de buscar y de escribir", async () => {
    conPayload({ email: "  Juan@Gmail.COM " });
    createCuentaMock.mockResolvedValue(cuentaCompleta({ id: 6 }));

    await pedir();

    expect(findUniqueMock.mock.calls[0][0].where.email).toBe("juan@gmail.com");
    expect(createCuentaMock.mock.calls[0][0].data.email).toBe("juan@gmail.com");
  });
});
