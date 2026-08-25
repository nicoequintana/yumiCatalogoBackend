import { describe, expect, it } from "vitest";
import { esEmailValido } from "./emailValido.js";

describe("esEmailValido", () => {
  it("acepta un email con forma algo@algo.algo", () => {
    expect(esEmailValido("cliente@gmail.com")).toBe(true);
  });

  it("ignora los espacios de los extremos", () => {
    expect(esEmailValido("  cliente@gmail.com  ")).toBe(true);
  });

  it("rechaza un string sin arroba", () => {
    expect(esEmailValido("clientegmail.com")).toBe(false);
  });

  it("rechaza un string sin punto en el dominio", () => {
    expect(esEmailValido("cliente@gmail")).toBe(false);
  });

  it("rechaza el string vacío", () => {
    expect(esEmailValido("")).toBe(false);
  });

  it("rechaza lo que no sea string sin lanzar", () => {
    expect(esEmailValido(undefined)).toBe(false);
    expect(esEmailValido(null)).toBe(false);
    expect(esEmailValido(42)).toBe(false);
  });
});
