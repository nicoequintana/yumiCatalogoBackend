import { describe, expect, it } from "vitest";
import { slugify, parsearIdDeRuta, rutaProducto } from "./slug.js";

describe("slugify", () => {
  it("pasa a minúsculas y reemplaza espacios por guiones", () => {
    expect(slugify("Set De Cuchillos")).toBe("set-de-cuchillos");
  });

  it("saca las tildes sin romper la palabra", () => {
    expect(slugify("Lámpara de diseño")).toBe("lampara-de-diseno");
  });

  it("conserva la ñ como n", () => {
    expect(slugify("Muñeco")).toBe("muneco");
  });

  it("descarta los símbolos", () => {
    expect(slugify("Vaso térmico 500ml ¡nuevo!")).toBe("vaso-termico-500ml-nuevo");
  });

  it("colapsa espacios y guiones repetidos en uno solo", () => {
    expect(slugify("Set   de --- cuchillos")).toBe("set-de-cuchillos");
  });

  it("no deja guiones en los extremos", () => {
    expect(slugify("  ¡Oferta!  ")).toBe("oferta");
  });

  it("devuelve string vacío para entrada vacía, nula o solo símbolos", () => {
    expect(slugify("")).toBe("");
    expect(slugify(null)).toBe("");
    expect(slugify(undefined)).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("corta a 80 caracteres sin dejar un guion colgando al final", () => {
    const largo = "palabra ".repeat(30);
    const resultado = slugify(largo);
    expect(resultado.length).toBeLessThanOrEqual(80);
    expect(resultado.endsWith("-")).toBe(false);
  });
});

describe("parsearIdDeRuta", () => {
  it("extrae el id de una ruta con slug", () => {
    expect(parsearIdDeRuta("123-set-de-cuchillos")).toBe(123);
  });

  it("acepta un id pelado, sin slug", () => {
    expect(parsearIdDeRuta("123")).toBe(123);
  });

  it("devuelve null cuando no arranca con dígitos", () => {
    expect(parsearIdDeRuta("set-de-cuchillos")).toBe(null);
  });

  it("devuelve null para un decimal, no 12", () => {
    // `Number("12.5")` no es NaN y llegaría a Prisma como filtro sobre un
    // `Int` -> 500. Mismo motivo por el que og.controller.js usa
    // `Number.isInteger` y no `Number.isNaN`.
    expect(parsearIdDeRuta("12.5")).toBe(null);
  });

  it("devuelve null para vacío, nulo o id cero/negativo", () => {
    expect(parsearIdDeRuta("")).toBe(null);
    expect(parsearIdDeRuta(null)).toBe(null);
    expect(parsearIdDeRuta("0")).toBe(null);
    expect(parsearIdDeRuta("-5")).toBe(null);
  });
});

describe("rutaProducto", () => {
  it("arma la ruta con id y slug", () => {
    expect(rutaProducto({ id: 123, nombre: "Set de cuchillos" })).toBe("/producto/123-set-de-cuchillos");
  });

  it("omite el guion cuando el nombre no deja slug", () => {
    expect(rutaProducto({ id: 7, nombre: "!!!" })).toBe("/producto/7");
  });
});
