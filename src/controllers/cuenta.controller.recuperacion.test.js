import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.COOKIE_DOMINIO = "";

const findUniqueMock = vi.fn();
const updateManyMock = vi.fn();
const tokenFindUniqueMock = vi.fn();
const createDispMock = vi.fn();
const invalidarMock = vi.fn();
const emitirTokenMock = vi.fn();
const consumirTokenMock = vi.fn();
const enviarResetMock = vi.fn();
const reservarSlotMock = vi.fn();
const hashearMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: { findUnique: (...a) => findUniqueMock(...a), updateMany: (...a) => updateManyMock(...a) },
    tokenCuenta: { findUnique: (...a) => tokenFindUniqueMock(...a) },
    dispositivoConocido: { create: (...a) => createDispMock(...a) },
  },
}));
vi.mock("../lib/tokensCuenta.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    invalidarTokensDe: (...a) => invalidarMock(...a),
    emitirToken: (...a) => emitirTokenMock(...a),
    consumirToken: (...a) => consumirTokenMock(...a),
  };
});
vi.mock("../lib/colaBcrypt.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, reservarSlot: (...a) => reservarSlotMock(...a) };
});
vi.mock("../lib/passwords.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, hashearPassword: (...a) => hashearMock(...a) };
});
vi.mock("../services/notificacionesCuenta.service.js", () => ({ enviarReset: (...a) => enviarResetMock(...a) }));

const { olvide, restablecer, MENSAJES_TOKEN } = await import("./cuenta.controller.js");
const { hashDeToken } = await import("../lib/tokensCuenta.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/olvide", olvide);
  app.post("/restablecer", restablecer);
  app.use(manejadorDeErrores);
  return app;
}

const liberarMock = vi.fn();

beforeEach(() => {
  [
    findUniqueMock,
    updateManyMock,
    tokenFindUniqueMock,
    createDispMock,
    invalidarMock,
    emitirTokenMock,
    consumirTokenMock,
    enviarResetMock,
    reservarSlotMock,
    hashearMock,
    liberarMock,
  ].forEach((m) => m.mockReset());
  createDispMock.mockResolvedValue({});
  invalidarMock.mockResolvedValue(undefined);
  enviarResetMock.mockResolvedValue(undefined);
  reservarSlotMock.mockResolvedValue(liberarMock);
  hashearMock.mockResolvedValue("HASH-NUEVO");
});

const MENSAJE = "Si hay una cuenta con ese email, te mandamos las instrucciones.";
const HACE_UNA_HORA = () => new Date(Date.now() - 60 * 60 * 1000);
const HACE_DOS_DIAS = () => new Date(Date.now() - 48 * 60 * 60 * 1000);

describe("olvide", () => {
  it("cuenta verificada: 200 generico y, DESPUES, emite RESET, invalida los previos menos el nuevo y manda el mail", async () => {
    const cuenta = { id: 1, email: "juan@gmail.com", emailVerificado: true, createdAt: HACE_DOS_DIAS() };
    const expiraEn = new Date(Date.now() + 60 * 60 * 1000);
    findUniqueMock.mockResolvedValue(cuenta);
    emitirTokenMock.mockResolvedValue({ tokenClaro: "abc", expiraEn });

    const res = await request(buildApp()).post("/olvide").send({ email: "Juan@Gmail.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mensaje: MENSAJE });
    await vi.waitFor(() => expect(enviarResetMock).toHaveBeenCalledWith(cuenta, { tokenClaro: "abc", expiraEn }));
    expect(findUniqueMock).toHaveBeenCalledWith({ where: { email: "juan@gmail.com" } });
    expect(emitirTokenMock).toHaveBeenCalledWith({ cuentaClienteId: 1, tipo: "RESET" });
    expect(invalidarMock).toHaveBeenCalledWith(1, "RESET", { excepto: hashDeToken("abc") });
  });

  it("cuenta inexistente: MISMO status y cuerpo, sin tocar tokens", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await request(buildApp()).post("/olvide").send({ email: "no@gmail.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mensaje: MENSAJE });
    await vi.waitFor(() => expect(findUniqueMock).toHaveBeenCalled());
    expect(emitirTokenMock).not.toHaveBeenCalled();
    expect(enviarResetMock).not.toHaveBeenCalled();
  });

  it("no verificada con mas de 24 h: se trata como INEXISTENTE (mismo cuerpo, no emite)", async () => {
    findUniqueMock.mockResolvedValue({ id: 2, email: "vieja@gmail.com", emailVerificado: false, createdAt: HACE_DOS_DIAS() });
    const res = await request(buildApp()).post("/olvide").send({ email: "vieja@gmail.com" });
    expect(res.body).toEqual({ mensaje: MENSAJE });
    await vi.waitFor(() => expect(findUniqueMock).toHaveBeenCalled());
    expect(emitirTokenMock).not.toHaveBeenCalled();
  });

  it("reasignada por el panel (verificadaEn puesto, no verificada, >24 h): SI emite — no es un registro abandonado", async () => {
    emitirTokenMock.mockResolvedValue({ tokenClaro: "t", expiraEn: new Date() });
    findUniqueMock.mockResolvedValue({
      id: 5, email: "reasignada@gmail.com", emailVerificado: false, verificadaEn: HACE_DOS_DIAS(), createdAt: HACE_DOS_DIAS(),
    });
    await request(buildApp()).post("/olvide").send({ email: "reasignada@gmail.com" });
    await vi.waitFor(() => expect(emitirTokenMock).toHaveBeenCalledWith({ cuentaClienteId: 5, tipo: "RESET" }));
  });

  it("no verificada dentro de la ventana y de Google sin contraseña: SI emite (Amenaza 21; Google adquiere contraseña)", async () => {
    emitirTokenMock.mockResolvedValue({ tokenClaro: "t", expiraEn: new Date() });
    for (const cuenta of [
      { id: 3, email: "nueva@gmail.com", emailVerificado: false, createdAt: HACE_UNA_HORA() },
      { id: 4, email: "google@gmail.com", emailVerificado: true, passwordHash: null, createdAt: HACE_DOS_DIAS() },
    ]) {
      findUniqueMock.mockResolvedValueOnce(cuenta);
      const res = await request(buildApp()).post("/olvide").send({ email: cuenta.email });
      expect(res.body).toEqual({ mensaje: MENSAJE });
      await vi.waitFor(() => expect(emitirTokenMock).toHaveBeenCalledWith({ cuentaClienteId: cuenta.id, tipo: "RESET" }));
    }
  });

  it("la respuesta NO espera a la base (Amenaza 16): con un findUnique colgado igual responde", async () => {
    findUniqueMock.mockReturnValue(new Promise(() => {}));
    const res = await request(buildApp()).post("/olvide").send({ email: "juan@gmail.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mensaje: MENSAJE });
  });

  it("email que no es string o de mas de 254: MISMO 200 y ni consulta la base", async () => {
    for (const email of [123, ["a@b.com"], `${"a".repeat(250)}@gmail.com`, undefined]) {
      const res = await request(buildApp()).post("/olvide").send({ email });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ mensaje: MENSAJE });
    }
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

describe("restablecer", () => {
  const TOKEN = "token-de-reset";
  const filaViva = () => ({
    cuentaClienteId: 1,
    tipo: "RESET",
    usadoEn: null,
    expiraEn: new Date(Date.now() + 30 * 60 * 1000),
  });
  const cuentaVerificada = () => ({ id: 1, email: "juan@gmail.com", dni: null, emailVerificado: true, createdAt: HACE_DOS_DIAS() });

  it("exporta los mensajes por motivo (los reusa el camino operado)", () => {
    expect(Object.keys(MENSAJES_TOKEN).sort()).toEqual(["INVALIDO", "USADO", "VENCIDO"]);
  });

  it("token o password que no son string: 400 sin tocar la base", async () => {
    const res = await request(buildApp()).post("/restablecer").send({ token: 5, password: "una-clave-larga-2" });
    expect(res.status).toBe(400);
    expect(tokenFindUniqueMock).not.toHaveBeenCalled();
    expect(consumirTokenMock).not.toHaveBeenCalled();
  });

  it("token de mas de 128 caracteres: MISMA respuesta que INVALIDO, sin hashear ni consultar", async () => {
    const res = await request(buildApp()).post("/restablecer").send({ token: "x".repeat(129), password: "una-clave-larga-2" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: MENSAJES_TOKEN.INVALIDO, motivo: "INVALIDO" });
    expect(tokenFindUniqueMock).not.toHaveBeenCalled();
    expect(consumirTokenMock).not.toHaveBeenCalled();
  });

  it("token no vivo (vencido/usado/de otro tipo): el motivo lo clasifica consumirToken con tipo RESET; ni bcrypt ni escritura", async () => {
    for (const [fila, motivo] of [
      [{ ...filaViva(), expiraEn: new Date(Date.now() - 1000) }, "VENCIDO"],
      [{ ...filaViva(), usadoEn: new Date() }, "USADO"],
      [{ ...filaViva(), tipo: "VERIFICACION" }, "INVALIDO"],
      [null, "INVALIDO"],
    ]) {
      tokenFindUniqueMock.mockResolvedValueOnce(fila);
      consumirTokenMock.mockResolvedValueOnce({ ok: false, motivo });
      const res = await request(buildApp()).post("/restablecer").send({ token: TOKEN, password: "una-clave-larga-2" });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: MENSAJES_TOKEN[motivo], motivo });
    }
    expect(consumirTokenMock).toHaveBeenCalledWith({ tokenClaro: TOKEN, tipo: "RESET" });
    expect(tokenFindUniqueMock).toHaveBeenCalledWith({ where: { tokenHash: hashDeToken(TOKEN) } });
    expect(hashearMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("exito: hashea, RECIEN DESPUES consume, y escribe hash + tokenVersion+1 + verificada + desbloqueo; dispositivo sí, sesion no", async () => {
    tokenFindUniqueMock.mockResolvedValue(filaViva());
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    consumirTokenMock.mockResolvedValue({ ok: true, fila: filaViva() });
    updateManyMock.mockResolvedValue({ count: 1 });

    const res = await request(buildApp()).post("/restablecer").send({ token: TOKEN, password: "una-clave-larga-2" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(hashearMock).toHaveBeenCalledWith("una-clave-larga-2");
    expect(liberarMock).toHaveBeenCalled();
    // El slot se suelta ANTES de consumir y escribir (ruling B).
    expect(liberarMock.mock.invocationCallOrder[0]).toBeLessThan(consumirTokenMock.mock.invocationCallOrder[0]);
    expect(hashearMock.mock.invocationCallOrder[0]).toBeLessThan(consumirTokenMock.mock.invocationCallOrder[0]);
    expect(consumirTokenMock).toHaveBeenCalledWith({ tokenClaro: TOKEN, tipo: "RESET" });

    const { where, data } = updateManyMock.mock.calls[0][0];
    expect(where.id).toBe(1);
    expect(where.OR).toEqual([{ emailVerificado: true }, { createdAt: { gte: expect.any(Date) } }]);
    // Primera escritura: solo matchea si verificadaEn es NULL, y lo setea.
    expect(where.verificadaEn).toBeNull();
    expect(data).toEqual({
      passwordHash: "HASH-NUEVO",
      tokenVersion: { increment: 1 },
      emailVerificado: true,
      intentosFallidos: 0,
      bloqueadoHasta: null,
      verificadaEn: expect.any(Date),
    });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const cookies = res.headers["set-cookie"] ?? [];
    expect(cookies.some((c) => c.startsWith("dispositivo_cliente="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("sesion_cliente="))).toBe(false);
  });

  it("clave rechazada (comun): 400 y el token NO se quema — se puede reintentar con el mismo link", async () => {
    tokenFindUniqueMock.mockResolvedValue(filaViva());
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const res = await request(buildApp()).post("/restablecer").send({ token: TOKEN, password: "12345678" });
    expect(res.status).toBe(400);
    expect(consumirTokenMock).not.toHaveBeenCalled();
    expect(hashearMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("cola de bcrypt llena: 503 y el token NO se quema", async () => {
    tokenFindUniqueMock.mockResolvedValue(filaViva());
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    reservarSlotMock.mockRejectedValue(Object.assign(new Error("Capacidad"), { status: 503, codigo: "CAPACIDAD" }));
    const res = await request(buildApp()).post("/restablecer").send({ token: TOKEN, password: "una-clave-larga-2" });
    expect(res.status).toBe(503);
    expect(consumirTokenMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("no verificada con mas de 24 h (o ya borrada): INVALIDO, sin bcrypt ni consumo — no se revive", async () => {
    for (const cuenta of [{ ...cuentaVerificada(), emailVerificado: false }, null]) {
      tokenFindUniqueMock.mockResolvedValueOnce(filaViva());
      findUniqueMock.mockResolvedValueOnce(cuenta);
      const res = await request(buildApp()).post("/restablecer").send({ token: TOKEN, password: "una-clave-larga-2" });
      expect(res.status).toBe(400);
      expect(res.body.motivo).toBe("INVALIDO");
    }
    expect(hashearMock).not.toHaveBeenCalled();
    expect(consumirTokenMock).not.toHaveBeenCalled();
  });

  it("no verificada dentro de la ventana: el reseteo la verifica (probo el buzon)", async () => {
    tokenFindUniqueMock.mockResolvedValue(filaViva());
    findUniqueMock.mockResolvedValue({ ...cuentaVerificada(), emailVerificado: false, createdAt: HACE_UNA_HORA() });
    consumirTokenMock.mockResolvedValue({ ok: true, fila: filaViva() });
    updateManyMock.mockResolvedValue({ count: 1 });
    const res = await request(buildApp()).post("/restablecer").send({ token: TOKEN, password: "una-clave-larga-2" });
    expect(res.status).toBe(200);
    expect(updateManyMock.mock.calls[0][0].data.emailVerificado).toBe(true);
  });

  it("reasignada por el panel (verificadaEn puesto, no verificada, >24 h): el reseteo funciona y no pisa verificadaEn", async () => {
    tokenFindUniqueMock.mockResolvedValue(filaViva());
    findUniqueMock.mockResolvedValue({
      ...cuentaVerificada(), emailVerificado: false, verificadaEn: HACE_DOS_DIAS(), createdAt: HACE_DOS_DIAS(),
    });
    consumirTokenMock.mockResolvedValue({ ok: true, fila: filaViva() });
    updateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

    const res = await request(buildApp()).post("/restablecer").send({ token: TOKEN, password: "una-clave-larga-2" });

    expect(res.status).toBe(200);
    const { where, data } = updateManyMock.mock.calls[1][0];
    expect(where).toEqual({ id: 1, verificadaEn: { not: null } });
    expect(data).toEqual({
      passwordHash: "HASH-NUEVO",
      tokenVersion: { increment: 1 },
      emailVerificado: true,
      intentosFallidos: 0,
      bloqueadoHasta: null,
    });
  });

  it("carrera: otro request consumio el token entre la lectura y el consumo -> USADO, sin escribir", async () => {
    tokenFindUniqueMock.mockResolvedValue(filaViva());
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    consumirTokenMock.mockResolvedValue({ ok: false, motivo: "USADO" });
    const res = await request(buildApp()).post("/restablecer").send({ token: TOKEN, password: "una-clave-larga-2" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: MENSAJES_TOKEN.USADO, motivo: "USADO" });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("la guarda de la escritura no matchea (purgada entre medio): INVALIDO y sin cookie de dispositivo", async () => {
    tokenFindUniqueMock.mockResolvedValue(filaViva());
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    consumirTokenMock.mockResolvedValue({ ok: true, fila: filaViva() });
    updateManyMock.mockResolvedValue({ count: 0 });
    const res = await request(buildApp()).post("/restablecer").send({ token: TOKEN, password: "una-clave-larga-2" });
    expect(res.status).toBe(400);
    expect(res.body.motivo).toBe("INVALIDO");
    expect(createDispMock).not.toHaveBeenCalled();
  });
});
