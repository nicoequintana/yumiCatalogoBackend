import { describe, expect, it } from "vitest";
import { validarRedacciones } from "./planillaGenerada.js";

const VALIDA = {
  nombre: "Lámpara Nómade",
  descripcion: "Una lámpara.",
  categoria: "Iluminación",
  etiqueta: null,
  fraseComercial: null,
  porQueLoVasAQuerer: null,
  tePasaEsto: null,
  caracteristicas: [],
  beneficios: [],
  usos: [],
  idealPara: [],
  incluye: [],
  especificaciones: [],
};

describe("validarRedacciones", () => {
  it("acepta una redacción completa", () => {
    expect(validarRedacciones([VALIDA])).toEqual([]);
  });

  it("exige nombre y descripción", () => {
    const errores = validarRedacciones([{ ...VALIDA, nombre: "", descripcion: "" }]);
    expect(errores).toHaveLength(2);
    expect(errores[0]).toMatch(/1/);
  });

  it("rechaza más de 3 beneficios porque el público solo muestra 3", () => {
    const errores = validarRedacciones([{ ...VALIDA, beneficios: ["a", "b", "c", "d"] }]);
    expect(errores.some((error) => /beneficios/i.test(error))).toBe(true);
  });

  it("rechaza una especificación sin nombre o sin valor", () => {
    const errores = validarRedacciones([{ ...VALIDA, especificaciones: [{ nombre: "Material", valor: "" }] }]);
    expect(errores.some((error) => /especificaciones/i.test(error))).toBe(true);
  });

  it("rechaza que la entrada no sea un array", () => {
    expect(() => validarRedacciones({})).toThrow(/array/i);
  });
});
