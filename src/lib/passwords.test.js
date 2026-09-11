import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import {
  COSTO_BCRYPT,
  HASH_SENUELO,
  compararPassword,
  hashearPassword,
  motivoPasswordRechazada,
  necesitaRehash,
} from "./passwords.js";

describe("passwords — costo", () => {
  it("el costo es 11: bcryptjs es JS puro y costo 12 cuesta 246 ms por hash en esta maquina", () => {
    expect(COSTO_BCRYPT).toBe(11);
  });

  it("hashearPassword produce un hash bcrypt con el costo configurado", async () => {
    const hash = await hashearPassword("una-clave-larga");
    expect(hash.startsWith("$2")).toBe(true);
    expect(bcrypt.getRounds(hash)).toBe(COSTO_BCRYPT);
  });

  it("compararPassword acepta la clave correcta y rechaza la incorrecta", async () => {
    const hash = await hashearPassword("una-clave-larga");
    expect(await compararPassword("una-clave-larga", hash)).toBe(true);
    expect(await compararPassword("otra", hash)).toBe(false);
  });

  it("el senuelo es un hash valido con el costo vigente, para que comparar contra el tarde lo mismo", () => {
    expect(bcrypt.getRounds(HASH_SENUELO)).toBe(COSTO_BCRYPT);
  });
});

describe("necesitaRehash", () => {
  it("un hash de costo 10 (los admins existentes) necesita rehash", () => {
    const viejo = bcrypt.hashSync("x", 10);
    expect(necesitaRehash(viejo)).toBe(true);
  });

  it("un hash del costo vigente no lo necesita", async () => {
    expect(necesitaRehash(await hashearPassword("x"))).toBe(false);
  });

  it("algo que no es un hash bcrypt se reporta como que necesita rehash, para que se regenere en el proximo login", () => {
    expect(necesitaRehash("no-es-un-hash")).toBe(true);
    expect(necesitaRehash(null)).toBe(true);
  });
});

describe("motivoPasswordRechazada", () => {
  const contexto = { email: "juan.perez@gmail.com", dni: "12345678" };

  it("acepta una clave razonable", () => {
    expect(motivoPasswordRechazada("mi perro se llama tobias", contexto)).toBeNull();
  });

  it("rechaza menos de 8 caracteres", () => {
    expect(motivoPasswordRechazada("corta1", contexto)).toMatch(/8 caracteres/);
  });

  it("rechaza mas de 128: bcrypt trunca a 72 bytes y un body grande es DoS por CPU", () => {
    expect(motivoPasswordRechazada("a".repeat(129), contexto)).toMatch(/128/);
  });

  it("rechaza las contrasenas mas usadas, sin importar mayusculas", () => {
    expect(motivoPasswordRechazada("12345678", contexto)).toMatch(/muy común/);
    expect(motivoPasswordRechazada("Password1", contexto)).toMatch(/muy común/);
    expect(motivoPasswordRechazada("CONTRASEÑA", contexto)).toMatch(/muy común/);
  });

  it("rechaza una clave que contenga el usuario del email o el DNI", () => {
    expect(motivoPasswordRechazada("juan.perez2024", contexto)).toMatch(/email/);
    expect(motivoPasswordRechazada("clave12345678x", contexto)).toMatch(/DNI/);
  });

  it("no explota sin contexto", () => {
    expect(motivoPasswordRechazada("mi perro se llama tobias", {})).toBeNull();
  });
});
