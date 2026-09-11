import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret-admin-con-largo-suficiente-32b";
process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";

const { firmarSesionCliente, verificarSesionCliente } = await import("./jwtCliente.js");

describe("jwtCliente", () => {
  const cuenta = { id: 3, email: "juan@gmail.com", tokenVersion: 2 };

  it("firma con los claims exactos del contrato y 7 dias", () => {
    const token = firmarSesionCliente(cuenta);
    const payload = jwt.decode(token);
    expect(payload).toMatchObject({ sub: 3, email: "juan@gmail.com", tokenVersion: 2, tipo: "cliente" });
    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60);
  });

  it("verifica su propio token", () => {
    const token = firmarSesionCliente(cuenta);
    expect(verificarSesionCliente(token)).toEqual({ id: 3, email: "juan@gmail.com", tokenVersion: 2 });
  });

  it("AISLAMIENTO: un token de ADMIN (firmado con JWT_SECRET) no verifica como cliente", () => {
    const tokenAdmin = jwt.sign({ sub: 3, email: "admin@yima.test", tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: "1h" });
    expect(verificarSesionCliente(tokenAdmin)).toBeNull();
  });

  it("AISLAMIENTO: un token con el secreto correcto pero sin tipo 'cliente' no verifica", () => {
    const sinTipo = jwt.sign({ sub: 3, email: "x", tokenVersion: 0 }, process.env.JWT_SECRET_CLIENTE, { expiresIn: "1h" });
    const otroTipo = jwt.sign({ sub: 3, email: "x", tokenVersion: 0, tipo: "admin" }, process.env.JWT_SECRET_CLIENTE, { expiresIn: "1h" });
    expect(verificarSesionCliente(sinTipo)).toBeNull();
    expect(verificarSesionCliente(otroTipo)).toBeNull();
  });

  it("rechaza alg=none y HS512: solo HS256", () => {
    const [h, p] = firmarSesionCliente(cuenta).split(".");
    const headerNone = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    expect(verificarSesionCliente(`${headerNone}.${p}.`)).toBeNull();
    const hs512 = jwt.sign({ sub: 3, email: "x", tokenVersion: 0, tipo: "cliente" }, process.env.JWT_SECRET_CLIENTE, { algorithm: "HS512", expiresIn: "1h" });
    expect(verificarSesionCliente(hs512)).toBeNull();
    void h;
  });

  it("un token vencido no verifica", () => {
    const vencido = jwt.sign({ sub: 3, email: "x", tokenVersion: 0, tipo: "cliente" }, process.env.JWT_SECRET_CLIENTE, { expiresIn: -10 });
    expect(verificarSesionCliente(vencido)).toBeNull();
  });

  it("Rama 1: un sub que no es entero devuelve null, no un objeto con id raro", () => {
    const subString = jwt.sign({ sub: "abc", email: "x", tokenVersion: 0, tipo: "cliente" }, process.env.JWT_SECRET_CLIENTE, { expiresIn: "1h" });
    const subFloat = jwt.sign({ sub: 1.5, email: "x", tokenVersion: 0, tipo: "cliente" }, process.env.JWT_SECRET_CLIENTE, { expiresIn: "1h" });
    expect(verificarSesionCliente(subString)).toBeNull();
    expect(verificarSesionCliente(subFloat)).toBeNull();
  });

  it("basura, vacio y no-string devuelven null sin lanzar", () => {
    expect(verificarSesionCliente("")).toBeNull();
    expect(verificarSesionCliente("a.b")).toBeNull();
    expect(verificarSesionCliente(undefined)).toBeNull();
  });
});
