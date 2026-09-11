import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.COOKIE_DOMINIO = "";

const findUniqueMock = vi.fn();
const updateManyMock = vi.fn();
const tokenUpdateManyMock = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: { findUnique: (...a) => findUniqueMock(...a), updateMany: (...a) => updateManyMock(...a) },
    tokenCuenta: { updateMany: (...a) => tokenUpdateManyMock(...a) },
  },
}));

const { cambiarPassword } = await import("./cuentaPerfil.controller.js");
const { hashearPassword } = await import("../lib/passwords.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cuentaCliente = { id: 1, email: "juan@gmail.com" };
    next();
  });
  app.put("/password", cambiarPassword);
  app.use(manejadorDeErrores);
  return app;
}

let HASH_ACTUAL;
beforeEach(async () => {
  findUniqueMock.mockReset();
  updateManyMock.mockReset();
  tokenUpdateManyMock.mockReset().mockResolvedValue({ count: 0 });
  HASH_ACTUAL = HASH_ACTUAL ?? (await hashearPassword("clave-actual-larga"));
});

describe("cambiarPassword", () => {
  it("actual incorrecta: 401, no escribe", async () => {
    findUniqueMock.mockResolvedValue({ id: 1, email: "juan@gmail.com", dni: null, passwordHash: HASH_ACTUAL, tokenVersion: 3 });
    const res = await request(buildApp()).put("/password").send({ actual: "mal", nueva: "otra-clave-larga" });
    expect(res.status).toBe(401);
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(tokenUpdateManyMock).not.toHaveBeenCalled();
  });

  it("nueva clave rechazada (comun): 400, no escribe", async () => {
    findUniqueMock.mockResolvedValue({ id: 1, email: "juan@gmail.com", dni: null, passwordHash: HASH_ACTUAL, tokenVersion: 3 });
    const res = await request(buildApp()).put("/password").send({ actual: "clave-actual-larga", nueva: "12345678" });
    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("faltan datos (no strings): 400, ni siquiera consulta la cuenta", async () => {
    const res = await request(buildApp()).put("/password").send({ actual: 123, nueva: "una-clave-nueva-y-larga" });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("cuenta de Google sin contraseña (passwordHash null): 401, nunca 500", async () => {
    findUniqueMock.mockResolvedValue({ id: 1, email: "juan@gmail.com", dni: null, passwordHash: null, tokenVersion: 0 });
    const res = await request(buildApp()).put("/password").send({ actual: "cualquier-cosa-larga", nueva: "una-clave-nueva-y-larga" });
    expect(res.status).toBe(401);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("exito: escribe hash + tokenVersion+1 guardado en el WHERE y REEMITE la cookie de sesion", async () => {
    findUniqueMock.mockResolvedValue({ id: 1, email: "juan@gmail.com", dni: null, passwordHash: HASH_ACTUAL, tokenVersion: 3 });
    updateManyMock.mockResolvedValue({ count: 1 });
    const res = await request(buildApp()).put("/password").send({ actual: "clave-actual-larga", nueva: "una-clave-nueva-y-larga" });
    expect(res.status).toBe(200);
    expect(updateManyMock.mock.calls[0][0].where).toMatchObject({ id: 1, tokenVersion: 3 });
    expect(updateManyMock.mock.calls[0][0].data).toMatchObject({ tokenVersion: { increment: 1 } });
    expect(res.headers["set-cookie"].some((c) => c.startsWith("sesion_cliente="))).toBe(true);
  });

  it("exito: revoca los CAMBIO_EMAIL, CODIGO_ACCESO y RESET pendientes (un secuestrador no confirma despues)", async () => {
    findUniqueMock.mockResolvedValue({ id: 1, email: "juan@gmail.com", dni: null, passwordHash: HASH_ACTUAL, tokenVersion: 3 });
    updateManyMock.mockResolvedValue({ count: 1 });
    const res = await request(buildApp()).put("/password").send({ actual: "clave-actual-larga", nueva: "una-clave-nueva-y-larga" });
    expect(res.status).toBe(200);
    const { where, data } = tokenUpdateManyMock.mock.calls[0][0];
    expect(where).toEqual({ cuentaClienteId: 1, tipo: { in: ["CAMBIO_EMAIL", "CODIGO_ACCESO", "RESET"] }, usadoEn: null });
    expect(data.usadoEn).toBeInstanceOf(Date);
    expect(updateManyMock.mock.invocationCallOrder[0]).toBeLessThan(tokenUpdateManyMock.mock.invocationCallOrder[0]);
  });

  it("cambio concurrente (tokenVersion ya no coincide): 409, la cookie no se reemite", async () => {
    findUniqueMock.mockResolvedValue({ id: 1, email: "juan@gmail.com", dni: null, passwordHash: HASH_ACTUAL, tokenVersion: 3 });
    updateManyMock.mockResolvedValue({ count: 0 });
    const res = await request(buildApp()).put("/password").send({ actual: "clave-actual-larga", nueva: "una-clave-nueva-y-larga" });
    expect(res.status).toBe(409);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(tokenUpdateManyMock).not.toHaveBeenCalled();
  });
});
