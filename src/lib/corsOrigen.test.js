import { describe, expect, it } from "vitest";
import { ORIGEN_POR_DEFECTO, parsearOrigenesCors } from "./corsOrigen.js";

describe("parsearOrigenesCors", () => {
  it("devuelve siempre un array, también cuando la variable no está seteada", () => {
    expect(parsearOrigenesCors(undefined)).toEqual([ORIGEN_POR_DEFECTO]);
    expect(parsearOrigenesCors(null)).toEqual([ORIGEN_POR_DEFECTO]);
  });

  it("recorta los espacios de cada origen (el bug del segundo origen bloqueado)", () => {
    // Escribir la lista con un espacio después de la coma es lo natural, y
    // antes dejaba " https://b.com" — que `cors` no matchea nunca.
    expect(parsearOrigenesCors("https://a.com, https://b.com")).toEqual(["https://a.com", "https://b.com"]);
  });

  it("descarta entradas vacías por comas de más o saltos de línea", () => {
    expect(parsearOrigenesCors("https://a.com,,https://b.com,")).toEqual(["https://a.com", "https://b.com"]);
    expect(parsearOrigenesCors("https://a.com,\n  https://b.com\n")).toEqual(["https://a.com", "https://b.com"]);
  });

  it("acepta un único origen sin comas", () => {
    expect(parsearOrigenesCors("https://yima.com")).toEqual(["https://yima.com"]);
  });

  it("cae al default cuando la variable está seteada pero en blanco", () => {
    expect(parsearOrigenesCors("")).toEqual([ORIGEN_POR_DEFECTO]);
    expect(parsearOrigenesCors("   ")).toEqual([ORIGEN_POR_DEFECTO]);
    expect(parsearOrigenesCors(",,,")).toEqual([ORIGEN_POR_DEFECTO]);
  });

  it("nunca devuelve una lista vacía (bloquearía todos los orígenes)", () => {
    for (const entrada of [undefined, "", "   ", ",", ", ,"]) {
      expect(parsearOrigenesCors(entrada).length).toBeGreaterThan(0);
    }
  });
});
