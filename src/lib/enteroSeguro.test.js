import { describe, expect, it } from "vitest";
import { esEnteroSeguro, parsearIdEntero } from "./enteroSeguro.js";

/**
 * El límite que fija este módulo se verificó contra el SQL Server real, no se
 * dedujo del schema: `?campania=9007199254740991` (2^53 - 1) responde 200 y
 * `?campania=9007199254740993` responde 500. La frontera es exactamente
 * `Number.isSafeInteger`, no el rango de la columna `Int`.
 */
describe("esEnteroSeguro", () => {
  it("acepta los enteros que Prisma puede mandar a la base", () => {
    expect(esEnteroSeguro(1)).toBe(true);
    expect(esEnteroSeguro(0)).toBe(true);
    expect(esEnteroSeguro(-5)).toBe(true);
    expect(esEnteroSeguro(2147483648)).toBe(true);
    expect(esEnteroSeguro(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("rechaza el entero que NO se puede representar exacto — el 500 de `1e21`", () => {
    expect(esEnteroSeguro(1e21)).toBe(false);
    expect(esEnteroSeguro(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(esEnteroSeguro(-1e21)).toBe(false);
  });

  it("rechaza lo que no es un entero", () => {
    expect(esEnteroSeguro(1.5)).toBe(false);
    expect(esEnteroSeguro(Number.NaN)).toBe(false);
    expect(esEnteroSeguro(Infinity)).toBe(false);
    expect(esEnteroSeguro("1")).toBe(false);
  });
});

describe("parsearIdEntero", () => {
  it("devuelve el número para un id válido, venga como string o como número", () => {
    expect(parsearIdEntero("7")).toBe(7);
    expect(parsearIdEntero(7)).toBe(7);
    expect(parsearIdEntero(" 7 ")).toBe(7);
  });

  it("devuelve null para un id fuera del rango representable", () => {
    // El caso que producía el 500 en `?campania=1e21`.
    expect(parsearIdEntero("1e21")).toBe(null);
    expect(parsearIdEntero("99999999999999999999")).toBe(null);
  });

  it("devuelve null para lo que no es un id positivo", () => {
    expect(parsearIdEntero("0")).toBe(null);
    expect(parsearIdEntero("-3")).toBe(null);
    expect(parsearIdEntero("1.5")).toBe(null);
    expect(parsearIdEntero("abc")).toBe(null);
    expect(parsearIdEntero("")).toBe(null);
    expect(parsearIdEntero(undefined)).toBe(null);
    // Un parámetro repetido (`?campania=1&campania=2`) llega como array.
    expect(parsearIdEntero(["1", "2"])).toBe(null);
  });
});
