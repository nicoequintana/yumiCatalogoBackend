import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

const updateManyMock = vi.fn();
const findUniqueMock = vi.fn();
const updateMock = vi.fn();
const tokenUpdateManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: {
      updateMany: (...a) => updateManyMock(...a),
      findUnique: (...a) => findUniqueMock(...a),
      update: (...a) => updateMock(...a),
    },
    tokenCuenta: { updateMany: (...a) => tokenUpdateManyMock(...a) },
  },
}));

const { actualizarPerfil, obtenerPerfil } = await import("./cuentaPerfil.controller.js");
const { salir } = await import("./cuentaLogin.controller.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cuentaCliente = { id: 1, email: "juan@gmail.com" };
    next();
  });
  app.post("/salir", salir);
  app.get("/perfil", obtenerPerfil);
  app.put("/perfil", actualizarPerfil);
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  updateManyMock.mockReset().mockResolvedValue({ count: 1 });
  findUniqueMock.mockReset();
  updateMock.mockReset();
  tokenUpdateManyMock.mockReset().mockResolvedValue({ count: 0 });
});

describe("salir", () => {
  it("incrementa tokenVersion, borra la cookie y responde 204", async () => {
    const res = await request(buildApp()).post("/salir");
    expect(res.status).toBe(204);
    expect(updateManyMock).toHaveBeenCalledWith({ where: { id: 1 }, data: { tokenVersion: { increment: 1 } } });
    expect(res.headers["set-cookie"].find((c) => c.startsWith("sesion_cliente=;"))).toBeDefined();
    // dispositivo_cliente NO se toca: "navegador conocido" no es sesion.
    expect(res.headers["set-cookie"].some((c) => c.startsWith("dispositivo_cliente="))).toBe(false);
  });

  it("cierra en todos lados: revoca el CAMBIO_EMAIL y el CODIGO_ACCESO pendientes", async () => {
    const res = await request(buildApp()).post("/salir");
    expect(res.status).toBe(204);
    const { where, data } = tokenUpdateManyMock.mock.calls[0][0];
    expect(where).toEqual({ cuentaClienteId: 1, tipo: { in: ["CAMBIO_EMAIL", "CODIGO_ACCESO"] }, usadoEn: null });
    expect(data.usadoEn).toBeInstanceOf(Date);
  });
});

describe("GET /cuenta", () => {
  it("emite el perfil sin el passwordHash, con tieneGoogle/tienePassword derivados", async () => {
    findUniqueMock.mockResolvedValue({
      id: 1,
      email: "juan@gmail.com",
      origenRegistro: "LOCAL",
      nombre: "Juan",
      telefono: "111",
      dni: "12345678",
      passwordHash: "$2a$11$x",
      identidadGoogle: null,
    });
    const res = await request(buildApp()).get("/perfil");
    expect(res.body).toEqual({
      id: 1,
      email: "juan@gmail.com",
      origenRegistro: "LOCAL",
      nombre: "Juan",
      telefono: "111",
      dni: "12345678",
      tieneGoogle: false,
      tienePassword: true,
    });
    expect(res.body.passwordHash).toBeUndefined();
  });

  it("cuenta de Google sin password: tienePassword false, tieneGoogle true", async () => {
    findUniqueMock.mockResolvedValue({
      id: 1,
      email: "juan@gmail.com",
      origenRegistro: "GOOGLE",
      nombre: null,
      telefono: null,
      dni: null,
      passwordHash: null,
      identidadGoogle: { cuentaClienteId: 1 },
    });
    const res = await request(buildApp()).get("/perfil");
    expect(res.body.tieneGoogle).toBe(true);
    expect(res.body.tienePassword).toBe(false);
  });

  it("cuenta borrada entre requests: 404, no 500", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await request(buildApp()).get("/perfil");
    expect(res.status).toBe(404);
  });
});

describe("PUT /cuenta", () => {
  it("lista blanca nombre/telefono/dni, valida el DNI", async () => {
    updateMock.mockResolvedValue({
      id: 1,
      email: "juan@gmail.com",
      origenRegistro: "LOCAL",
      nombre: "Juan Perez",
      telefono: "111",
      dni: "12345678",
      passwordHash: null,
      identidadGoogle: null,
    });
    const res = await request(buildApp())
      .put("/perfil")
      .send({ nombre: "Juan Perez", telefono: "111", dni: "12.345.678", tokenVersion: 999 });
    expect(res.status).toBe(200);
    expect(updateMock.mock.calls[0][0].data).toEqual({ nombre: "Juan Perez", telefono: "111", dni: "12345678" });
    expect(res.body.nombre).toBe("Juan Perez");
  });

  it("DNI invalido: 400, no llega a escribir", async () => {
    const res = await request(buildApp()).put("/perfil").send({ dni: "123" });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("nombre vacio: 400, no llega a escribir", async () => {
    const res = await request(buildApp()).put("/perfil").send({ nombre: "   " });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("nombre mas largo que la columna: 400, no llega a escribir", async () => {
    const res = await request(buildApp()).put("/perfil").send({ nombre: "a".repeat(1001) });
    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("cuenta borrada entre requests (P2025): 404, no 500", async () => {
    const err = new Error("No record was found for an update.");
    err.code = "P2025";
    updateMock.mockRejectedValue(err);
    const res = await request(buildApp()).put("/perfil").send({ nombre: "Juan Perez" });
    expect(res.status).toBe(404);
  });
});
