import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret-admin-con-largo-suficiente-32b";
process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.COOKIE_DOMINIO = "";

const findUniqueMock = vi.fn();
vi.mock("../lib/prisma.js", () => ({
  prisma: { cuentaCliente: { findUnique: (...args) => findUniqueMock(...args) } },
}));

const { manejadorDeErrores } = await import("./errorHandler.js");
const { authClienteOpcional, requireCliente } = await import("./authCliente.middleware.js");
const { firmarSesionCliente } = await import("../lib/jwtCliente.js");

function buildApp() {
  const app = express();
  app.get("/privada", requireCliente, (req, res) => res.json({ cuenta: req.cuentaCliente }));
  app.get("/opcional", authClienteOpcional, (req, res) => res.json({ cuenta: req.cuentaCliente ?? null }));
  app.use(manejadorDeErrores);
  return app;
}

const CUENTA = { id: 3, email: "juan@gmail.com", tokenVersion: 0, emailVerificado: true };
const cookieDe = (token) => `sesion_cliente=${token}`;

beforeEach(() => {
  findUniqueMock.mockReset();
});

describe("requireCliente", () => {
  it("con cookie valida y cuenta vigente, pone req.cuentaCliente = { id, email } y NADA mas", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    const res = await request(buildApp()).get("/privada").set("Cookie", cookieDe(firmarSesionCliente(CUENTA)));
    expect(res.status).toBe(200);
    expect(res.body.cuenta).toEqual({ id: 3, email: "juan@gmail.com" });
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: 3 },
      select: { id: true, email: true, tokenVersion: true, emailVerificado: true },
    });
  });

  it("sin cookie: 401 SESION_INVALIDA", async () => {
    const res = await request(buildApp()).get("/privada");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "No autorizado.", codigo: "SESION_INVALIDA" });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("NO lee Authorization: Bearer — la sesion de cliente vive en la cookie", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    const res = await request(buildApp()).get("/privada").set("Authorization", `Bearer ${firmarSesionCliente(CUENTA)}`);
    expect(res.status).toBe(401);
  });

  it("token de ADMIN en la cookie: 401", async () => {
    const tokenAdmin = jwt.sign({ sub: 3, email: "a@b", tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await request(buildApp()).get("/privada").set("Cookie", cookieDe(tokenAdmin));
    expect(res.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("tokenVersion atrasada (revocada): 401 y borra la cookie", async () => {
    findUniqueMock.mockResolvedValue({ ...CUENTA, tokenVersion: 1 });
    const res = await request(buildApp()).get("/privada").set("Cookie", cookieDe(firmarSesionCliente(CUENTA)));
    expect(res.status).toBe(401);
    expect(res.body.codigo).toBe("SESION_INVALIDA");
    const borrada = res.headers["set-cookie"].find((c) => c.startsWith("sesion_cliente="));
    expect(borrada).toMatch(/^sesion_cliente=;/);
  });

  it("cuenta borrada: 401", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await request(buildApp()).get("/privada").set("Cookie", cookieDe(firmarSesionCliente(CUENTA)));
    expect(res.status).toBe(401);
  });

  it("cuenta NO verificada: 401 aunque el token sea valido (decision 4)", async () => {
    findUniqueMock.mockResolvedValue({ ...CUENTA, emailVerificado: false });
    const res = await request(buildApp()).get("/privada").set("Cookie", cookieDe(firmarSesionCliente(CUENTA)));
    expect(res.status).toBe(401);
  });

  it("Rama 1: sub no entero firmado con el secreto correcto: 401 sin consultar la base", async () => {
    const raro = jwt.sign({ sub: "abc", email: "x", tokenVersion: 0, tipo: "cliente" }, process.env.JWT_SECRET_CLIENTE, { expiresIn: "1h" });
    const res = await request(buildApp()).get("/privada").set("Cookie", cookieDe(raro));
    expect(res.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("Rama 2: la base no contesta: 503 VERIFICACION_NO_DISPONIBLE y la cookie NO se borra", async () => {
    findUniqueMock.mockRejectedValue(new Error("timeout"));
    const res = await request(buildApp()).get("/privada").set("Cookie", cookieDe(firmarSesionCliente(CUENTA)));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "No pudimos verificar tu sesión, reintentá.", codigo: "VERIFICACION_NO_DISPONIBLE" });
    expect(res.headers["set-cookie"] ?? []).toEqual([]);
  });
});

describe("authClienteOpcional", () => {
  it("sin cookie sigue de largo con req.cuentaCliente ausente", async () => {
    const res = await request(buildApp()).get("/opcional");
    expect(res.status).toBe(200);
    expect(res.body.cuenta).toBeNull();
  });

  it("con cookie valida puebla req.cuentaCliente", async () => {
    findUniqueMock.mockResolvedValue(CUENTA);
    const res = await request(buildApp()).get("/opcional").set("Cookie", cookieDe(firmarSesionCliente(CUENTA)));
    expect(res.body.cuenta).toEqual({ id: 3, email: "juan@gmail.com" });
  });

  it("con cookie revocada degrada a anonimo Y borra la cookie, sin cortar", async () => {
    findUniqueMock.mockResolvedValue({ ...CUENTA, tokenVersion: 5 });
    const res = await request(buildApp()).get("/opcional").set("Cookie", cookieDe(firmarSesionCliente(CUENTA)));
    expect(res.status).toBe(200);
    expect(res.body.cuenta).toBeNull();
    expect(res.headers["set-cookie"].find((c) => c.startsWith("sesion_cliente=;"))).toBeDefined();
  });

  it("con la base caida NO degrada a anonimo: 503 (en el checkout, 'anonimo' seria comprar como invitado con el flag apagado)", async () => {
    findUniqueMock.mockRejectedValue(new Error("timeout"));
    const res = await request(buildApp()).get("/opcional").set("Cookie", cookieDe(firmarSesionCliente(CUENTA)));
    expect(res.status).toBe(503);
    expect(res.body.codigo).toBe("VERIFICACION_NO_DISPONIBLE");
  });
});
