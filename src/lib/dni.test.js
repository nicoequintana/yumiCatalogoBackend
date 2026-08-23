import { describe, expect, it } from "vitest";
import { normalizarDni, esDniValido } from "./dni.js";

describe("normalizarDni", () => {
  it("saca puntos", () => {
    expect(normalizarDni("12.345.678")).toBe("12345678");
  });

  it("saca espacios", () => {
    expect(normalizarDni("12 345 678")).toBe("12345678");
  });

  it("saca cualquier caracter no numérico (guiones, letras, etc.)", () => {
    expect(normalizarDni("12-345-678a")).toBe("12345678");
  });

  it("deja un dni ya limpio intacto", () => {
    expect(normalizarDni("12345678")).toBe("12345678");
  });

  it("devuelve string vacío si no hay dígitos", () => {
    expect(normalizarDni("abc.def")).toBe("");
  });

  it("maneja input no-string sin explotar (coerciona a string)", () => {
    expect(normalizarDni(12345678)).toBe("12345678");
  });
});

describe("esDniValido", () => {
  it("acepta 7 dígitos (mínimo válido)", () => {
    expect(esDniValido("1234567")).toBe(true);
  });

  it("acepta 8 dígitos (máximo válido)", () => {
    expect(esDniValido("12345678")).toBe(true);
  });

  it("rechaza 6 dígitos (muy corto)", () => {
    expect(esDniValido("123456")).toBe(false);
  });

  it("rechaza 9 dígitos (muy largo)", () => {
    expect(esDniValido("123456789")).toBe(false);
  });

  it("rechaza string vacío", () => {
    expect(esDniValido("")).toBe(false);
  });

  it("rechaza dni con letras (asume ya normalizado, pero no debe explotar)", () => {
    expect(esDniValido("1234567a")).toBe(false);
  });

  it("rechaza null/undefined", () => {
    expect(esDniValido(null)).toBe(false);
    expect(esDniValido(undefined)).toBe(false);
  });
});
