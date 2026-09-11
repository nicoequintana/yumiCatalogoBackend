import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const findUniqueMock = vi.fn();
const txMock = vi.fn();
const txCuentaUpdateMock = vi.fn();
const txTokenUpdateManyMock = vi.fn();
const txIdentidadDeleteManyMock = vi.fn();
const txDispositivoDeleteManyMock = vi.fn();
const txCuentaDeleteManyMock = vi.fn();
const auditCreateMock = vi.fn();
const usuarioFindUniqueMock = vi.fn();
const emitirTokenMock = vi.fn();
const enviarVerificacionMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: { findUnique: (...a) => findUniqueMock(...a) },
    auditLog: { create: (...a) => auditCreateMock(...a) },
    usuario: { findUnique: (...a) => usuarioFindUniqueMock(...a) },
    $transaction: (...a) => txMock(...a),
  },
}));
vi.mock("../lib/tokensCuenta.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, emitirToken: (...a) => emitirTokenMock(...a) };
});
vi.mock("../services/notificacionesCuenta.service.js", () => ({
  enviarVerificacion: (...a) => enviarVerificacionMock(...a),
}));

const { reasignarEmail } = await import("./adminCuentasCliente.controller.js");
const { default: adminRouter } = await import("../routes/admin.routes.js");
const { manejadorDeErrores } = await import("../middlewares/errorHandler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.usuario = { id: 9, email: "admin@yima.local" };
    next();
  });
  app.put("/admin/cuentas-cliente/:id/email", reasignarEmail);
  app.use(manejadorDeErrores);
  return app;
}

function buildAppReal() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use(manejadorDeErrores);
  return app;
}

const CUENTA = { id: 1, email: "viejo@gmail.com", nombre: "Juan", emailVerificado: true, verificadaEn: new Date("2026-01-01") };

function mockTx({ updateRechaza } = {}) {
  if (updateRechaza) txCuentaUpdateMock.mockRejectedValue(updateRechaza);
  else txCuentaUpdateMock.mockImplementation(async ({ data }) => ({ ...CUENTA, ...data, tokenVersion: 1 }));
  txTokenUpdateManyMock.mockResolvedValue({ count: 0 });
  txIdentidadDeleteManyMock.mockResolvedValue({ count: 0 });
  txDispositivoDeleteManyMock.mockResolvedValue({ count: 0 });
  txCuentaDeleteManyMock.mockResolvedValue({ count: 0 });
  txMock.mockImplementation(async (fn) =>
    fn({
      cuentaCliente: { update: txCuentaUpdateMock, deleteMany: txCuentaDeleteManyMock },
      tokenCuenta: { updateMany: txTokenUpdateManyMock },
      identidadGoogle: { deleteMany: txIdentidadDeleteManyMock },
      dispositivoConocido: { deleteMany: txDispositivoDeleteManyMock },
    }),
  );
}

beforeEach(() => {
  [
    findUniqueMock, txMock, txCuentaUpdateMock, txTokenUpdateManyMock, txIdentidadDeleteManyMock,
    txDispositivoDeleteManyMock, txCuentaDeleteManyMock,
    auditCreateMock, usuarioFindUniqueMock, emitirTokenMock, enviarVerificacionMock,
  ].forEach((m) => m.mockReset());
  auditCreateMock.mockResolvedValue({});
  enviarVerificacionMock.mockResolvedValue();
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: false });
});

const put = (app, id, body) => request(app).put(`/admin/cuentas-cliente/${id}/email`).send(body);

describe("reasignarEmail (admin, camino operado)", () => {
  it("reasigna al email normalizado, sube tokenVersion, deja emailVerificado en false y NO pisa verificadaEn", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    mockTx();
    const res = await put(buildApp(), 1, { emailNuevo: "  Nuevo@Gmail.com " });
    expect(res.status).toBe(200);
    const { where, data } = txCuentaUpdateMock.mock.calls[0][0];
    expect(where).toEqual({ id: 1 });
    expect(data).toMatchObject({ email: "nuevo@gmail.com", emailVerificado: false, tokenVersion: { increment: 1 } });
    // `verificadaEn` intacto: "olvidé mi contraseña" sigue funcionando pasadas las 24 h.
    expect(data).not.toHaveProperty("verificadaEn");
  });

  it("la clave vieja y los dispositivos viejos NO sobreviven: passwordHash null, contador a cero y DispositivoConocido borrados, en la MISMA transaccion", async () => {
    findUniqueMock.mockResolvedValue({ ...CUENTA, passwordHash: "$2b$12$vieja", intentosFallidos: 4 });
    mockTx();
    const res = await put(buildApp(), 1, { emailNuevo: "nuevo@gmail.com" });
    expect(res.status).toBe(200);
    // Con passwordHash null el login compara contra el señuelo: la clave vieja da 401.
    expect(txCuentaUpdateMock.mock.calls[0][0].data).toMatchObject({ passwordHash: null, intentosFallidos: 0, bloqueadoHasta: null });
    expect(txDispositivoDeleteManyMock).toHaveBeenCalledWith({ where: { cuentaClienteId: 1 } });
  });

  it("una fila nunca verificada, vencida y sin pedidos que tiene el email nuevo se purga ANTES de escribir (no da 409 por una cuenta muerta)", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    mockTx();
    const res = await put(buildApp(), 1, { emailNuevo: "nuevo@gmail.com" });
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

  it("emite la verificación con enviarVerificacion(cuenta) de 1 argumento, a la dirección NUEVA, sin emitir token propio (ruling E)", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    mockTx();
    await put(buildApp(), 1, { emailNuevo: "nuevo@gmail.com" });
    expect(enviarVerificacionMock).toHaveBeenCalledTimes(1);
    expect(enviarVerificacionMock.mock.calls[0]).toHaveLength(1);
    expect(enviarVerificacionMock.mock.calls[0][0]).toMatchObject({ id: 1, email: "nuevo@gmail.com" });
    expect(emitirTokenMock).not.toHaveBeenCalled();
  });

  it("en la MISMA transacción: invalida todo token vivo (fueron al buzón viejo) y desvincula Google", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    mockTx();
    await put(buildApp(), 1, { emailNuevo: "nuevo@gmail.com" });
    const { where, data } = txTokenUpdateManyMock.mock.calls[0][0];
    expect(where).toEqual({ cuentaClienteId: 1, usadoEn: null });
    expect(data.usadoEn).toBeInstanceOf(Date);
    expect(txIdentidadDeleteManyMock).toHaveBeenCalledWith({ where: { cuentaClienteId: 1 } });
  });

  it("audita quién, qué cuenta y los dos emails — nunca un hash ni una contraseña", async () => {
    findUniqueMock.mockResolvedValue({ ...CUENTA, passwordHash: "$2b$12$secreto" });
    mockTx();
    await put(buildApp(), 1, { emailNuevo: "nuevo@gmail.com" });
    await vi.waitFor(() => expect(auditCreateMock).toHaveBeenCalled());
    const { data } = auditCreateMock.mock.calls[0][0];
    expect(data).toMatchObject({ usuarioId: 9, usuarioEmail: "admin@yima.local", entidad: "CuentaCliente", entidadId: 1 });
    expect(JSON.parse(data.detalle)).toEqual({ emailAnterior: "viejo@gmail.com", emailNuevo: "nuevo@gmail.com" });
    expect(JSON.stringify(data)).not.toMatch(/secreto|password/i);
  });

  it("email ya en uso por otra cuenta (P2002): 409, sin mail ni auditoría", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    mockTx({ updateRechaza: Object.assign(new Error("dup"), { code: "P2002" }) });
    const res = await put(buildApp(), 1, { emailNuevo: "en-uso@gmail.com" });
    expect(res.status).toBe(409);
    expect(enviarVerificacionMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("cuenta inexistente: 404 sin abrir transacción", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await put(buildApp(), 999, { emailNuevo: "x@gmail.com" });
    expect(res.status).toBe(404);
    expect(txMock).not.toHaveBeenCalled();
  });

  it("borrada entre la lectura y la escritura (P2025): 404", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    mockTx({ updateRechaza: Object.assign(new Error("gone"), { code: "P2025" }) });
    const res = await put(buildApp(), 1, { emailNuevo: "nuevo@gmail.com" });
    expect(res.status).toBe(404);
  });

  it("id no entero: 404 sin tocar la base", async () => {
    const res = await put(buildApp(), "abc", { emailNuevo: "x@gmail.com" });
    expect(res.status).toBe(404);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no es string", 123],
    ["mas de 254", `${"a".repeat(250)}@gmail.com`],
    ["sin forma de email", "no-es-un-email"],
    ["ausente", undefined],
  ])("email nuevo inválido (%s): 400 sin tocar la base", async (_caso, emailNuevo) => {
    const res = await put(buildApp(), 1, { emailNuevo });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("el mismo email que ya tiene (normalizado): 400, no escribe", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    const res = await put(buildApp(), 1, { emailNuevo: "Viejo@Gmail.com" });
    expect(res.status).toBe(400);
    expect(txMock).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/cuentas-cliente/:id/email (montado en admin.routes)", () => {
  it("sin token de admin: 401 antes de tocar la cuenta", async () => {
    const res = await request(buildAppReal()).put("/api/admin/cuentas-cliente/1/email").send({ emailNuevo: "nuevo@gmail.com" });
    expect(res.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("un token de CLIENTE no sirve aunque esté firmado con el secreto del admin", async () => {
    const tokenCliente = jwt.sign({ sub: 1, tokenVersion: 0, tipo: "cliente" }, "test-secret", { expiresIn: "7d" });
    const res = await request(buildAppReal())
      .put("/api/admin/cuentas-cliente/1/email")
      .set("Authorization", `Bearer ${tokenCliente}`)
      .send({ emailNuevo: "nuevo@gmail.com" });
    expect(res.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("con Bearer de admin: 200", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    mockTx();
    const token = jwt.sign({ sub: 1, email: "admin@yima.local", tokenVersion: 0 }, "test-secret", { expiresIn: "7d" });
    const res = await request(buildAppReal())
      .put("/api/admin/cuentas-cliente/1/email")
      .set("Authorization", `Bearer ${token}`)
      .send({ emailNuevo: "nuevo@gmail.com" });
    expect(res.status).toBe(200);
  });
});
