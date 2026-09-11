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
const { hashDeToken } = await import("../lib/tokensCuenta.js");

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
    txCuentaFindUniqueMock, txCuentaUpdateMock, txIdentidadDeleteMock, invalidarMock, emitirTokenMock,
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
  function mockTx({ consumido = true, identidadGoogle = null, updateRechaza, verificadaEn = new Date("2026-01-01") } = {}) {
    txTokenUpdateManyMock.mockResolvedValue({ count: consumido ? 1 : 0 });
    txTokenFindUniqueMock.mockResolvedValue({ cuentaClienteId: 1, emailNuevo: "nuevo@gmail.com" });
    txCuentaFindUniqueMock.mockResolvedValue({ id: 1, identidadGoogle, verificadaEn });
    if (updateRechaza) txCuentaUpdateMock.mockRejectedValue(updateRechaza);
    else txCuentaUpdateMock.mockResolvedValue({});
    txIdentidadDeleteMock.mockResolvedValue({});
    txMock.mockImplementation(async (fn) =>
      fn({
        tokenCuenta: { updateMany: txTokenUpdateManyMock, findUnique: txTokenFindUniqueMock },
        cuentaCliente: { findUnique: txCuentaFindUniqueMock, update: txCuentaUpdateMock },
        identidadGoogle: { delete: txIdentidadDeleteMock },
      }),
    );
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

  it("token no vivo: el consumo guardado no escribe, se clasifica el motivo y la cuenta no se toca", async () => {
    mockTx({ consumido: false });
    consumirTokenMock.mockResolvedValue({ ok: false, motivo: "USADO" });
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    expect(res.status).toBe(400);
    expect(res.body.motivo).toBe("USADO");
    expect(consumirTokenMock).toHaveBeenCalledWith({ tokenClaro: "x", tipo: "CAMBIO_EMAIL" });
    expect(txCuentaUpdateMock).not.toHaveBeenCalled();
  });

  it("exito sin Google: consume DENTRO de la transaccion con tipo en el where, cambia email, emailVerificado true, tokenVersion+1", async () => {
    mockTx();
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    expect(res.status).toBe(200);
    const { where, data } = txTokenUpdateManyMock.mock.calls[0][0];
    expect(where).toMatchObject({ tokenHash: hashDeToken("x"), tipo: "CAMBIO_EMAIL", usadoEn: null });
    expect(where.expiraEn.gt).toBeInstanceOf(Date);
    expect(data.usadoEn).toBeInstanceOf(Date);
    expect(txCuentaUpdateMock).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { email: "nuevo@gmail.com", emailVerificado: true, tokenVersion: { increment: 1 } },
    });
    expect(txIdentidadDeleteMock).not.toHaveBeenCalled();
    expect(consumirTokenMock).not.toHaveBeenCalled();
    expect(res.body.mensaje).not.toMatch(/Google/);
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
    txMock.mockImplementation(async (fn) => {
      await fn({
        tokenCuenta: { updateMany: txTokenUpdateManyMock, findUnique: txTokenFindUniqueMock },
        cuentaCliente: { findUnique: txCuentaFindUniqueMock, update: txCuentaUpdateMock },
        identidadGoogle: { delete: txIdentidadDeleteMock },
      });
    });
    const res = await request(buildApp()).post("/email/confirmar").send({ token: "x" });
    expect(res.status).toBe(409);
    expect(txTokenUpdateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyTokenGlobalMock).not.toHaveBeenCalled();
    expect(consumirTokenMock).not.toHaveBeenCalled();
  });
});
