import { describe, expect, it } from "vitest";
import { esUrlHttpsValida } from "./urlHttpsValida.js";

describe("esUrlHttpsValida", () => {
  it("acepta una URL https:// válida", () => {
    expect(esUrlHttpsValida("https://instagram.com/yima")).toBe(true);
  });

  it("ignora los espacios de los extremos", () => {
    expect(esUrlHttpsValida("  https://instagram.com/yima  ")).toBe(true);
  });

  it("rechaza http:// (sin cifrar)", () => {
    expect(esUrlHttpsValida("http://instagram.com/yima")).toBe(false);
  });

  it("rechaza javascript:", () => {
    expect(esUrlHttpsValida("javascript:alert(1)")).toBe(false);
  });

  it("rechaza data:", () => {
    expect(esUrlHttpsValida("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rechaza un string mal formado", () => {
    expect(esUrlHttpsValida("no-es-una-url")).toBe(false);
  });

  it("rechaza el string vacío", () => {
    expect(esUrlHttpsValida("")).toBe(false);
  });

  it("rechaza lo que no sea string sin lanzar", () => {
    expect(esUrlHttpsValida(undefined)).toBe(false);
    expect(esUrlHttpsValida(null)).toBe(false);
    expect(esUrlHttpsValida(42)).toBe(false);
  });
});
