import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.COOKIE_DOMINIO = "";

const findUniqueMock = vi.fn();
const createDispMock = vi.fn();
const consumirCodigoMock = vi.fn();
const emitirCodigoMock = vi.fn();
const enviarCodigoMock = vi.fn();
const tokenUpdateManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: { findUnique: (...a) => findUniqueMock(...a) },
    dispositivoConocido: { create: (...a) => createDispMock(...a) },
    tokenCuenta: { updateMany: (...a) => tokenUpdateManyMock(...a) },
  },
}));
vi.mock("../lib/tokensCuenta.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, consumirCodigoAcceso: (...a) => consumirCodigoMock(...a), emitirCodigoAcceso: (...a) => emitirCodigoMock(...a) };
});
vi.mock("../services/notificacionesCuenta.service.js", () => ({ enviarCodigoAcceso: (...a) => enviarCodigoMock(...a) }));

const { loginConCodigo, reenviarCodigo } = await import("./cuentaLogin.controller.js");
const { manejadorDeErrores } = await import("../middlewares/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/codigo", loginConCodigo);
  app.post("/codigo/reenviar", reenviarCodigo);
  app.use(manejadorDeErrores);
  return app;
}

const CUENTA = { id: 1, email: "x@gmail.com", tokenVersion: 0, emailVerificado: true };

beforeEach(() => {
  findUniqueMock.mockReset().mockResolvedValue(CUENTA);
  createDispMock.mockReset().mockResolvedValue({});
  consumirCodigoMock.mockReset();
  emitirCodigoMock.mockReset().mockResolvedValue({ codigo: "123456", expiraEn: new Date(Date.now() + 600_000) });
  // A diferencia del borrador del brief: `.mockResolvedValue`, no solo
  // `mockReset()` — el handler hace `.catch(...)` sobre el resultado del
  // sender (fire-and-forget, mismo criterio que `login`), y un mock sin
  // valor resuelto devuelve `undefined`, que no tiene `.catch` y rompe el
  // handler ANTES de responder.
  enviarCodigoMock.mockReset().mockResolvedValue(undefined);
  tokenUpdateManyMock.mockReset().mockResolvedValue({ count: 1 });
});

/**
 * El trabajo de fondo de `reenviarCodigo` corre después de `res.json` y sus
 * mocks resuelven enseguida: un `setImmediate` corre recién cuando se vació
 * toda la cadena de microtareas del handler. Es la señal determinista de "el
 * fondo terminó" para afirmar que algo NO se llamó — sin sleeps por reloj.
 */
const vaciarFondo = () => new Promise((resolver) => setImmediate(resolver));

describe("loginConCodigo", () => {
  it("codigo correcto: cookie de sesion Y de dispositivo, 200 ok", async () => {
    consumirCodigoMock.mockResolvedValue({ ok: true });
    const res = await request(buildApp()).post("/codigo").send({ email: "x@gmail.com", codigo: "123456" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["set-cookie"].some((c) => c.startsWith("sesion_cliente="))).toBe(true);
    expect(res.headers["set-cookie"].some((c) => c.startsWith("dispositivo_cliente="))).toBe(true);
    expect(createDispMock).toHaveBeenCalledWith({ data: expect.objectContaining({ cuentaClienteId: 1 }) });
  });

  it("codigo incorrecto o agotado: 401 sin cookies", async () => {
    consumirCodigoMock.mockResolvedValue({ ok: false });
    const res = await request(buildApp()).post("/codigo").send({ email: "x@gmail.com", codigo: "000000" });
    expect(res.status).toBe(401);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("email de una cuenta inexistente: 401 sin llamar a consumirCodigoAcceso", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await request(buildApp()).post("/codigo").send({ email: "no@gmail.com", codigo: "123456" });
    expect(res.status).toBe(401);
    expect(consumirCodigoMock).not.toHaveBeenCalled();
  });

  // Regla del repo (ruling de Parte 2a, carried): una no verificada se
  // trata como inexistente en todo el login — acá NUNCA existió un
  // CODIGO_ACCESO para ella (ni `login` ni `reenviarCodigo` lo emiten sin
  // `emailVerificado`), así que este guard es cinturón y tirantes.
  it("cuenta no verificada: 401 sin llamar a consumirCodigoAcceso", async () => {
    findUniqueMock.mockResolvedValue({ ...CUENTA, emailVerificado: false });
    const res = await request(buildApp()).post("/codigo").send({ email: "x@gmail.com", codigo: "123456" });
    expect(res.status).toBe(401);
    expect(consumirCodigoMock).not.toHaveBeenCalled();
  });

  // Ruling de Parte 1 (controller rulings, carried): un email que no es
  // string o pasa los 254 caracteres del índice UNIQUE ni se normaliza ni
  // toca la base — el mismo guard que `login` y `registro`.
  it.each([
    ["email no string", 123],
    ["email de más de 254 caracteres", `${"a".repeat(250)}@gmail.com`],
  ])("%s: 401 sin tocar la base", async (_caso, email) => {
    const res = await request(buildApp()).post("/codigo").send({ email, codigo: "123456" });
    expect(res.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

describe("reenviarCodigo", () => {
  it("cuenta verificada con un codigo VIVO: lo invalida con la condicion en el where y recien ahi emite y manda, 200 generico", async () => {
    const res = await request(buildApp()).post("/codigo/reenviar").send({ email: "x@gmail.com" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(emitirCodigoMock).toHaveBeenCalledWith(1));
    await vi.waitFor(() => expect(enviarCodigoMock).toHaveBeenCalledTimes(1));
    const { where, data } = tokenUpdateManyMock.mock.calls[0][0];
    expect(where).toMatchObject({ cuentaClienteId: 1, tipo: "CODIGO_ACCESO", usadoEn: null });
    expect(where.expiraEn.gt).toBeInstanceOf(Date);
    expect(data.usadoEn).toBeInstanceOf(Date);
    expect(tokenUpdateManyMock.mock.invocationCallOrder[0]).toBeLessThan(emitirCodigoMock.mock.invocationCallOrder[0]);
  });

  it("cuenta verificada SIN codigo vivo: MISMO 200 y no emite ni manda — el reenvio no es un login sin contraseña", async () => {
    tokenUpdateManyMock.mockResolvedValue({ count: 0 });
    const res = await request(buildApp()).post("/codigo/reenviar").send({ email: "x@gmail.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mensaje: "Si corresponde, te mandamos un código nuevo." });
    await vi.waitFor(() => expect(tokenUpdateManyMock).toHaveBeenCalled());
    await vaciarFondo();
    expect(emitirCodigoMock).not.toHaveBeenCalled();
    expect(enviarCodigoMock).not.toHaveBeenCalled();
  });

  it("la respuesta NO espera a la base (Amenaza 16): con un findUnique colgado igual responde", async () => {
    findUniqueMock.mockReturnValue(new Promise(() => {}));
    const res = await request(buildApp()).post("/codigo/reenviar").send({ email: "x@gmail.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mensaje: "Si corresponde, te mandamos un código nuevo." });
  });

  it("cuenta inexistente: MISMO 200, sin mandar nada", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await request(buildApp()).post("/codigo/reenviar").send({ email: "no@gmail.com" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(findUniqueMock).toHaveBeenCalled());
    await vaciarFondo();
    expect(tokenUpdateManyMock).not.toHaveBeenCalled();
    expect(emitirCodigoMock).not.toHaveBeenCalled();
    expect(enviarCodigoMock).not.toHaveBeenCalled();
  });

  // Misma amenaza 16 que `/registro`: una cuenta no verificada no puede
  // distinguirse por status ni cuerpo de una inexistente.
  it("cuenta no verificada: MISMO 200, sin mandar nada", async () => {
    findUniqueMock.mockResolvedValue({ ...CUENTA, emailVerificado: false });
    const res = await request(buildApp()).post("/codigo/reenviar").send({ email: "x@gmail.com" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(findUniqueMock).toHaveBeenCalled());
    await vaciarFondo();
    expect(tokenUpdateManyMock).not.toHaveBeenCalled();
    expect(emitirCodigoMock).not.toHaveBeenCalled();
    expect(enviarCodigoMock).not.toHaveBeenCalled();
  });

  it.each([
    ["email no string", 123],
    ["email de más de 254 caracteres", `${"a".repeat(250)}@gmail.com`],
  ])("%s: 200 sin tocar la base", async (_caso, email) => {
    const res = await request(buildApp()).post("/codigo/reenviar").send({ email });
    expect(res.status).toBe(200);
    // La consulta corre después de responder: sin vaciar el fondo, este
    // `not.toHaveBeenCalled` pasaría aunque el handler sí consultara.
    await vaciarFondo();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("responde 200 ANTES de emitir/mandar el código (Amenaza 16: sin diferencia de tiempo por cuenta existente)", async () => {
    let resuelto = false;
    emitirCodigoMock.mockImplementation(
      () => new Promise((resolver) => setTimeout(() => { resuelto = true; resolver({ codigo: "123456", expiraEn: new Date() }); }, 40)),
    );
    const res = await request(buildApp()).post("/codigo/reenviar").send({ email: "x@gmail.com" });
    expect(res.status).toBe(200);
    // La respuesta ya volvió: si `emitirCodigoAcceso` se hubiese esperado
    // ANTES de responder, `resuelto` sería `true` acá.
    expect(resuelto).toBe(false);
    await vi.waitFor(() => expect(resuelto).toBe(true));
  });
});
