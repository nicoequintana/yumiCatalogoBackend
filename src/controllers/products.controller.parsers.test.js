import { describe, expect, it } from "vitest";
import { parseListas, parseEspecificaciones, validarCamposBase } from "./products.input.js";

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

describe("validarCamposBase — el precio salió de acá", () => {
  // `precio` dejó de ser una entrada del contrato el 31/08/2026: el precio de
  // venta se deriva de `costo × coeficiente` y no se tipea en ninguna pantalla.
  //
  // Las reglas que este bloque fijaba —entero, finito, mayor a 0, y los
  // decimales en cero aceptados porque lo que se rechaza son los centavos y no
  // la notación— NO desaparecieron: se mudaron al COSTO, que es el campo que
  // ahora recibe ese número. Viven en `products.input.test.js`, sobre
  // `validarCostoYCoeficiente`.
  const base = { nombre: "Vela", descripcion: "Aromática" };

  it("ignora por completo un precio que venga en el body", () => {
    // No es un 400 a propósito: el campo dejó de existir, así que un cliente
    // viejo que todavía lo mande tiene que seguir funcionando. Lo que decide el
    // precio es el costo, y de eso se ocupa el controller.
    expect(() =>
      validarCamposBase({ ...base, precio: "-50" }, { esCreacion: true }),
    ).not.toThrow();
    expect(() =>
      validarCamposBase({ ...base, precio: "1500.60" }, { esCreacion: true }),
    ).not.toThrow();
    expect(() =>
      validarCamposBase({ ...base, precio: "Infinity" }, { esCreacion: true }),
    ).not.toThrow();
  });

  it("sigue exigiendo nombre y descripción en el alta", () => {
    expect(() => validarCamposBase({ descripcion: "Aromática" }, { esCreacion: true })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => validarCamposBase({ nombre: "Vela" }, { esCreacion: true })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("en actualización, omitir un campo no valida nada", () => {
    expect(() => validarCamposBase({}, { esCreacion: false })).not.toThrow();
  });
});
