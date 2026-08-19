import { describe, expect, it } from "vitest";
import { parseListas, parseEspecificaciones } from "./products.controller.js";

describe("parseListas", () => {
  it("retorna undefined si raw es undefined (campo omitido)", () => {
    expect(parseListas(undefined, "BENEFICIO")).toBeUndefined();
  });

  it("parsea un array JSON de {texto} y agrega el tipo", () => {
    const raw = JSON.stringify([{ texto: "Recargable por USB" }, { texto: "Portátil" }]);
    expect(parseListas(raw, "BENEFICIO")).toEqual([
      { texto: "Recargable por USB", tipo: "BENEFICIO" },
      { texto: "Portátil", tipo: "BENEFICIO" },
    ]);
  });

  it("descarta items con texto vacío tras trim", () => {
    const raw = JSON.stringify([{ texto: "  " }, { texto: "Válido" }]);
    expect(parseListas(raw, "USO")).toEqual([{ texto: "Válido", tipo: "USO" }]);
  });

  it("rechaza JSON inválido con 400", () => {
    expect(() => parseListas("{no es array}", "BENEFICIO")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("rechaza un valor que no es array", () => {
    expect(() => parseListas(JSON.stringify({ texto: "x" }), "BENEFICIO")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe("parseEspecificaciones", () => {
  it("retorna undefined si raw es undefined", () => {
    expect(parseEspecificaciones(undefined)).toBeUndefined();
  });

  it("parsea un array JSON de {nombre, valor}", () => {
    const raw = JSON.stringify([{ nombre: "Material", valor: "ABS" }]);
    expect(parseEspecificaciones(raw)).toEqual([{ nombre: "Material", valor: "ABS" }]);
  });

  it("descarta filas donde nombre o valor están vacíos tras trim", () => {
    const raw = JSON.stringify([
      { nombre: "Material", valor: "" },
      { nombre: "", valor: "ABS" },
      { nombre: "Peso", valor: "250 g" },
    ]);
    expect(parseEspecificaciones(raw)).toEqual([{ nombre: "Peso", valor: "250 g" }]);
  });

  it("rechaza JSON inválido con 400", () => {
    expect(() => parseEspecificaciones("no json")).toThrow(expect.objectContaining({ status: 400 }));
  });
});
