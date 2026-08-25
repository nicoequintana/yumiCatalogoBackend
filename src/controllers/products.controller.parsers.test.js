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

describe("validarCamposBase — precio", () => {
  // Mismo criterio que `normalizarPrecio` del importador de planillas
  // (`lib/importProductos.js`): entero, finito y mayor a 0. Antes el formulario
  // era más laxo que el `.xlsx`: un precio negativo entraba a la base (y de ahí
  // a los snapshots de `ItemOrden` de futuras órdenes), y `"Infinity"` pasaba
  // el chequeo de NaN y reventaba contra el `Decimal` de Prisma con un 500.
  const base = { nombre: "Vela", descripcion: "Aromática" };

  it("acepta un precio entero positivo (número o string multipart)", () => {
    expect(() => validarCamposBase({ ...base, precio: "1500" }, { esCreacion: true })).not.toThrow();
    expect(() => validarCamposBase({ ...base, precio: 100 }, { esCreacion: true })).not.toThrow();
    // Un entero escrito con decimales en cero sigue siendo entero: lo que se
    // rechaza son los centavos, no la notación.
    expect(() => validarCamposBase({ ...base, precio: "1500.00" }, { esCreacion: true })).not.toThrow();
  });

  // La columna es `Decimal(10, 0)`: si esto pasara, SQL Server guardaría 1501
  // sin avisar y el admin vería un precio que no cargó. El 400 es lo único que
  // convierte esa corrección silenciosa en algo que se puede ver y corregir.
  it("rechaza un precio con centavos con 400", () => {
    expect(() => validarCamposBase({ ...base, precio: "1500.60" }, { esCreacion: true })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => validarCamposBase({ ...base, precio: 0.5 }, { esCreacion: true })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("rechaza un precio negativo con 400", () => {
    expect(() => validarCamposBase({ ...base, precio: "-50" }, { esCreacion: true })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it('rechaza "Infinity" con 400 (no es NaN, pero no es un precio)', () => {
    expect(() => validarCamposBase({ ...base, precio: "Infinity" }, { esCreacion: true })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("rechaza 0 con 400, igual que el importador (> 0 estricto)", () => {
    expect(() => validarCamposBase({ ...base, precio: "0" }, { esCreacion: true })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("rechaza un precio no numérico con 400", () => {
    expect(() => validarCamposBase({ ...base, precio: "abc" }, { esCreacion: true })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("en actualización, omitir el precio no valida nada", () => {
    expect(() => validarCamposBase({ ...base, precio: undefined }, { esCreacion: false })).not.toThrow();
  });
});
