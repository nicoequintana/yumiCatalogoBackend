import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.COOKIE_DOMINIO = "";

const findUniqueMock = vi.fn();
const updateManyTokenGlobalMock = vi.fn();
const txMock = vi.fn();
const txTokenUpdateManyMock = vi.fn();
const txTokenFindUniqueMock = vi.fn();
const txCuentaFindUniqueMock = vi.fn();
const txCuentaUpdateMock = vi.fn();
const txIdentidadDeleteMock = vi.fn();
const txCuentaDeleteManyMock = vi.fn();
const invalidarMock = vi.fn();
const emitirTokenMock = vi.fn();
const consumirTokenMock = vi.fn();
const enviarCambioEmailMock = vi.fn();
const enviarAvisoMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: { findUnique: (...a) => findUniqueMock(...a) },
    tokenCuenta: { updateMany: (...a) => updateManyTokenGlobalMock(...a) },
    $transaction: (...a) => txMock(...a),
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
vi.mock("../services/notificacionesCuenta.service.js", () => ({
  enviarCambioEmail: (...a) => enviarCambioEmailMock(...a),
  enviarAvisoCambioEmail: (...a) => enviarAvisoMock(...a),
  enviarCodigoAcceso: vi.fn(),
  enviarReset: vi.fn(),
  enviarVerificacion: vi.fn(),
  enviarYaTenesCuenta: vi.fn(),
}));

const { cambiarEmail, confirmarEmail } = await import("./cuenta.controller.js");
const { hashearPassword } = await import("../lib/passwords.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cuentaCliente = { id: 1, email: "juan@gmail.com" };
    next();
  });
  app.put("/email", cambiarEmail);
  app.post("/email/confirmar", confirmarEmail);
  app.use(manejadorDeErrores);
  return app;
}

const EXPIRA = new Date("2026-09-12T00:00:00Z");
let HASH;
beforeEach(async () => {
  [
    findUniqueMock, updateManyTokenGlobalMock, txMock, txTokenUpdateManyMock, txTokenFindUniqueMock,
    txCuentaFindUniqueMock, txCuentaUpdateMock, txIdentidadDeleteMock, txCuentaDeleteManyMock, invalidarMock, emitirTokenMock,
    consumirTokenMock, enviarCambioEmailMock, enviarAvisoMock,
  ].forEach((m) => m.mockReset());
  emitirTokenMock.mockResolvedValue({ tokenClaro: "abc", expiraEn: EXPIRA, id: 88 });
  invalidarMock.mockResolvedValue();
  enviarCambioEmailMock.mockResolvedValue();
  enviarAvisoMock.mockResolvedValue();
  HASH = HASH ?? (await hashearPassword("clave-actual-larga"));
});

const cuentaLocal = (extra = {}) => ({ id: 1, email: "juan@gmail.com", passwordHash: HASH, identidadGoogle: null, ...extra });

describe("PUT /cuenta/email (cambiarEmail)", () => {
  it.each([
    ["no es string", 123],
    ["mas de 254", `${"a".repeat(250)}@gmail.com`],
    ["sin forma de email", "no-es-un-email"],
  ])("email nuevo invalido (%s): 400 sin tocar la base", async (_caso, emailNuevo) => {
    const res = await request(buildApp()).put("/email").send({ emailNuevo, password: "clave-actual-larga" });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("password que no es string: 400 sin tocar la base", async () => {
    const res = await request(buildApp()).put("/email").send({ emailNuevo: "nuevo@gmail.com", password: ["x"] });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("contraseña incorrecta: 401, no emite token ni manda mails", async () => {
    findUniqueMock.mockResolvedValue(cuentaLocal());
    const res = await request(buildApp()).put("/email").send({ emailNuevo: "nuevo@gmail.com", password: "mal" });
    expect(res.status).toBe(401);
    expect(emitirTokenMock).not.toHaveBeenCalled();
    expect(enviarCambioEmailMock).not.toHaveBeenCalled();
  });

  it("cuenta de Google sin contraseña: 401, nunca 500", async () => {
    findUniqueMock.mockResolvedValue(cuentaLocal({ passwordHash: null, identidadGoogle: { cuentaClienteId: 1 } }));
    const res = await request(buildApp()).put("/email").send({ emailNuevo: "nuevo@gmail.com", password: "cualquier-cosa" });
    expect(res.status).toBe(401);
    expect(emitirTokenMock).not.toHaveBeenCalled();
  });

  it("el mismo email que ya tiene (normalizado): 400, no emite", async () => {
    findUniqueMock.mockResolvedValue(cuentaLocal());
    const res = await request(buildApp()).put("/email").send({ emailNuevo: "  Juan@Gmail.com ", password: "clave-actual-larga" });
    expect(res.status).toBe(400);
    expect(emitirTokenMock).not.toHaveBeenCalled();
  });

  it("exito: emite CAMBIO_EMAIL con el nuevo normalizado, invalida los previos DESPUES y manda link a la nueva y aviso a la vieja", async () => {
    findUniqueMock.mockResolvedValue(cuentaLocal());
    const res = await request(buildApp()).put("/email").send({ emailNuevo: "Nuevo@Gmail.com", password: "clave-actual-larga" });
    expect(res.status).toBe(200);
    expect(emitirTokenMock).toHaveBeenCalledWith({ cuentaClienteId: 1, tipo: "CAMBIO_EMAIL", emailNuevo: "nuevo@gmail.com" });
    expect(invalidarMock).toHaveBeenCalledWith(1, "CAMBIO_EMAIL", { anterioresA: 88 });
    expect(emitirTokenMock.mock.invocationCallOrder[0]).toBeLessThan(invalidarMock.mock.invocationCallOrder[0]);
    expect(enviarCambioEmailMock).toHaveBeenCalledWith(expect.objectContaining({ id: 1, email: "juan@gmail.com" }), {
      emailNuevo: "nuevo@gmail.com",
      tokenClaro: "abc",
    });
    expect(enviarAvisoMock).toHaveBeenCalledWith(expect.objectContaining({ id: 1, email: "juan@gmail.com" }), {
      emailNuevo: "nuevo@gmail.com",
    });
    expect(res.body.mensaje).not.toMatch(/Google/);
  });

  it("no revela si el email nuevo ya es de otra cuenta: nunca lo consulta en este paso", async () => {
    findUniqueMock.mockResolvedValue(cuentaLocal());
    await request(buildApp()).put("/email").send({ emailNuevo: "otra@gmail.com", password: "clave-actual-larga" });
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock.mock.calls[0][0].where).toEqual({ id: 1 });
  });

  it("con Google vinculado: avisa en la respuesta que al confirmar se desvincula", async () => {
    findUniqueMock.mockResolvedValue(cuentaLocal({ identidadGoogle: { cuentaClienteId: 1 } }));
    const res = await request(buildApp()).put("/email").send({ emailNuevo: "nuevo@gmail.com", password: "clave-actual-larga" });
    expect(res.status).toBe(200);
    expect(res.body.mensaje).toMatch(/Google/);
  });

  it("un sender que rechaza no tumba la respuesta", async () => {
    findUniqueMock.mockResolvedValue(cuentaLocal());
    enviarCambioEmailMock.mockRejectedValue(new Error("smtp"));
    const res = await request(buildApp()).put("/email").send({ emailNuevo: "nuevo@gmail.com", password: "clave-actual-larga" });
    expect(res.status).toBe(200);
  });
});

describe("POST /cuenta/email/confirmar (confirmarEmail)", () => {
  let TX;
  function mockTx({ consumido = true, motivo = "USADO", identidadGoogle = null, updateRechaza, verificadaEn = new Date("2026-01-01") } = {}) {
    consumirTokenMock.mockResolvedValue(
      consumido ? { ok: true, fila: { cuentaClienteId: 1, emailNuevo: "nuevo@gmail.com" } } : { ok: false, motivo },
    );
    txTokenUpdateManyMock.mockResolvedValue({ count: 0 });
    txCuentaFindUniqueMock.mockResolvedValue({ id: 1, identidadGoogle, verificadaEn });
    txCuentaDeleteManyMock.mockResolvedValue({ count: 0 });
    if (updateRechaza) txCuentaUpdateMock.mockRejectedValue(updateRechaza);
    else txCuentaUpdateMock.mockResolvedValue({});
    txIdentidadDeleteMock.mockResolvedValue({});
    TX = {
      tokenCuenta: { updateMany: txTokenUpdateManyMock, findUnique: txTokenFindUniqueMock },
      cuentaCliente: { findUnique: txCuentaFindUniqueMock, update: txCuentaUpdateMock, deleteMany: txCuentaDeleteManyMock },
      identidadGoogle: { delete: txIdentidadDeleteMock },
    };
    txMock.mockImplementation(async (fn) => fn(TX));
  }

  it("sin token: 400", async () => {
    const res = await request(buildApp()).post("/email/confirmar").send({});
    expect(res.status).toBe(400);
    expect(txMock).not.toHaveBeenCalled();
  });

  it("token de mas de 128: 400 INVALIDO sin hashear ni abrir transaccion", async () => {
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x".repeat(129) });
    expect(res.status).toBe(400);
    expect(res.body.motivo).toBe("INVALIDO");
    expect(txMock).not.toHaveBeenCalled();
  });

  it("token no vivo: consumirToken lo clasifica DENTRO de la transaccion (una sola llamada) y la cuenta no se toca", async () => {
    mockTx({ consumido: false, motivo: "USADO" });
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    expect(res.status).toBe(400);
    expect(res.body.motivo).toBe("USADO");
    expect(consumirTokenMock).toHaveBeenCalledTimes(1);
    expect(consumirTokenMock).toHaveBeenCalledWith({ tokenClaro: "x", tipo: "CAMBIO_EMAIL" }, TX);
    expect(txCuentaUpdateMock).not.toHaveBeenCalled();
    expect(txTokenUpdateManyMock).not.toHaveBeenCalled();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("exito sin Google: consume por el cliente de la transaccion, cambia email, emailVerificado true, tokenVersion+1", async () => {
    mockTx();
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    expect(res.status).toBe(200);
    expect(consumirTokenMock).toHaveBeenCalledWith({ tokenClaro: "x", tipo: "CAMBIO_EMAIL" }, TX);
    expect(txCuentaUpdateMock).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { email: "nuevo@gmail.com", emailVerificado: true, tokenVersion: { increment: 1 } },
    });
    expect(txIdentidadDeleteMock).not.toHaveBeenCalled();
    expect(updateManyTokenGlobalMock).not.toHaveBeenCalled();
    expect(res.body.mensaje).not.toMatch(/Google/);
  });

  it("exito: en la MISMA transaccion revoca los RESET, CODIGO_ACCESO y otros CAMBIO_EMAIL pendientes (fueron al buzon viejo)", async () => {
    mockTx();
    await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    const { where, data } = txTokenUpdateManyMock.mock.calls[0][0];
    expect(where).toEqual({ cuentaClienteId: 1, tipo: { in: ["RESET", "CODIGO_ACCESO", "CAMBIO_EMAIL"] }, usadoEn: null });
    expect(data.usadoEn).toBeInstanceOf(Date);
    expect(updateManyTokenGlobalMock).not.toHaveBeenCalled();
  });

  it("exito: borra la cookie de sesion del navegador que confirma (su tokenVersion ya no vale)", async () => {
    mockTx();
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    expect(res.status).toBe(200);
    expect((res.headers["set-cookie"] ?? []).some((c) => c.startsWith("sesion_cliente=;"))).toBe(true);
  });

  it("una fila abandonada (nunca verificada, vencida, sin pedidos) con el email nuevo se purga ANTES de escribir, dentro de la transaccion", async () => {
    mockTx();
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    expect(res.status).toBe(200);
    expect(txCuentaDeleteManyMock).toHaveBeenCalledWith({
      where: {
        email: "nuevo@gmail.com",
        emailVerificado: false,
        verificadaEn: null,
        createdAt: { lt: expect.any(Date) },
        ordenes: { none: {} },
      },
    });
    expect(txCuentaDeleteManyMock.mock.invocationCallOrder[0]).toBeLessThan(txCuentaUpdateMock.mock.invocationCallOrder[0]);
  });

  it("cuenta sin verificadaEn (fila previa a la columna): la confirmacion lo setea; nunca pisa uno existente (test de arriba)", async () => {
    mockTx({ verificadaEn: null });
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    expect(res.status).toBe(200);
    expect(txCuentaUpdateMock.mock.calls[0][0].data).toEqual({
      email: "nuevo@gmail.com",
      emailVerificado: true,
      tokenVersion: { increment: 1 },
      verificadaEn: expect.any(Date),
    });
  });

  it("con Google vinculado: la MISMA transaccion borra la IdentidadGoogle y la respuesta lo dice", async () => {
    mockTx({ identidadGoogle: { cuentaClienteId: 1 } });
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    expect(res.status).toBe(200);
    expect(txIdentidadDeleteMock).toHaveBeenCalledWith({ where: { cuentaClienteId: 1 } });
    expect(res.body.mensaje).toMatch(/Google/);
  });

  it("P2002 (email ya usado): 409; el consumo fue por el cliente de la transaccion, asi el rollback lo des-consume", async () => {
    const p2002 = Object.assign(new Error("dup"), { code: "P2002" });
    mockTx({ updateRechaza: p2002 });
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    expect(res.status).toBe(409);
    expect(consumirTokenMock).toHaveBeenCalledTimes(1);
    expect(consumirTokenMock.mock.calls[0][1]).toBe(TX);
    expect(updateManyTokenGlobalMock).not.toHaveBeenCalled();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
