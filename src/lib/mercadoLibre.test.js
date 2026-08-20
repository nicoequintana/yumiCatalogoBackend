import { describe, expect, it } from "vitest";
import { extraerIdML } from "./mercadoLibre.js";

describe("extraerIdML", () => {
  it("extrae el id de una URL de artículo con guion", () => {
    expect(extraerIdML("https://articulo.mercadolibre.com.ar/MLA-123456789-lampara-nomade-_JM")).toBe(
      "MLA123456789",
    );
  });

  it("extrae el id de una URL de producto de catálogo", () => {
    expect(extraerIdML("https://www.mercadolibre.com.ar/p/MLA987654321")).toBe("MLA987654321");
  });

  it("ignora query params y fragmentos", () => {
    expect(extraerIdML("https://articulo.mercadolibre.com.ar/MLA-111222333-x-_JM?pdp_filters=a#pos=1")).toBe(
      "MLA111222333",
    );
  });

  it("acepta un id pelado", () => {
    expect(extraerIdML("MLA555")).toBe("MLA555");
  });

  it("devuelve null cuando la URL no tiene un id de ML", () => {
    expect(extraerIdML("https://example.com/producto")).toBeNull();
  });

  it("devuelve null ante entrada vacía", () => {
    expect(extraerIdML("")).toBeNull();
    expect(extraerIdML(null)).toBeNull();
  });
});
