import { describe, it, expect } from "vitest";
import { validarCostoYCoeficiente } from "./products.input.js";

/**
 * Validación de los dos campos nuevos del editor de producto.
 *
 * Los tres valores que puede devolver cada campo son distintos y no
 * intercambiables:
 *   `undefined` -> no vino en el request, no se toca la columna
 *   `null`      -> vino vacío, se BORRA la columna
 *   string      -> valor normalizado listo para Prisma
 */
describe("validarCostoYCoeficiente", () => {
  it("no toca nada cuando ninguno de los dos viene", () => {
    expect(validarCostoYCoeficiente({})).toEqual({ costo: undefined, coeficiente: undefined });
  });

  it("normaliza valores válidos a string", () => {
    expect(validarCostoYCoeficiente({ costo: "14504", coeficiente: "2.05" })).toEqual({
      costo: "14504",
      coeficiente: "2.05",
    });
    expect(validarCostoYCoeficiente({ costo: 14504, coeficiente: 2.05 })).toEqual({
      costo: "14504",
      coeficiente: "2.05",
    });
  });

  // Un campo vaciado en el formulario tiene que poder BORRAR el dato. Sin esta
  // rama, un producto al que se le cargó un costo por error quedaría con él
  // para siempre.
  it("un valor vacío borra la columna", () => {
    expect(validarCostoYCoeficiente({ costo: "", coeficiente: "" })).toEqual({
      costo: null,
      coeficiente: null,
    });
    expect(validarCostoYCoeficiente({ costo: null, coeficiente: null })).toEqual({
      costo: null,
      coeficiente: null,
    });
  });

  it("los dos campos son independientes", () => {
    expect(validarCostoYCoeficiente({ costo: "5000" })).toEqual({
      costo: "5000",
      coeficiente: undefined,
    });
    expect(validarCostoYCoeficiente({ coeficiente: "1.8" })).toEqual({
      costo: undefined,
      coeficiente: "1.8",
    });
  });

  // El costo es plata: mismo criterio que `precio`, entero y sin decimales. Si
  // dejara pasar 1500.60, SQL Server lo guardaría como 1501 sin avisarle a
  // nadie y el margen calculado sería falso.
  it("rechaza un costo con decimales", () => {
    expect(() => validarCostoYCoeficiente({ costo: "1500.60" })).toThrow(/entero/i);
  });

  it("rechaza un costo no positivo o no numérico", () => {
    expect(() => validarCostoYCoeficiente({ costo: "0" })).toThrow(/mayor a 0/i);
    expect(() => validarCostoYCoeficiente({ costo: "-100" })).toThrow(/mayor a 0/i);
    expect(() => validarCostoYCoeficiente({ costo: "abc" })).toThrow();
    expect(() => validarCostoYCoeficiente({ costo: "Infinity" })).toThrow();
  });

  // La columna es Decimal(5,2): un tercer decimal se redondearía en silencio y
  // el precio calculado dejaría de coincidir con el que muestra la pantalla.
  it("rechaza un coeficiente con más de dos decimales", () => {
    expect(() => validarCostoYCoeficiente({ coeficiente: "2.055" })).toThrow(/dos decimales/i);
  });

  it("rechaza un coeficiente fuera del rango de la columna", () => {
    expect(() => validarCostoYCoeficiente({ coeficiente: "1000" })).toThrow(/999/);
    expect(() => validarCostoYCoeficiente({ coeficiente: "0" })).toThrow(/mayor a 0/i);
    expect(() => validarCostoYCoeficiente({ coeficiente: "-2" })).toThrow(/mayor a 0/i);
  });

  // En Argentina el coeficiente se tipea con coma. Aceptarla no es adivinar:
  // "2,05" y "2.05" son el mismo número sin ninguna ambigüedad, y un 400 por
  // el separador decimal sería una pared arbitraria. Distinto del PRECIO, donde
  // lo que se rechaza es el decimal en sí, no su notación.
  it("acepta coma como separador decimal en el coeficiente", () => {
    expect(validarCostoYCoeficiente({ coeficiente: "2,05" })).toEqual({
      costo: undefined,
      coeficiente: "2.05",
    });
  });

  it("ignora espacios alrededor", () => {
    expect(validarCostoYCoeficiente({ costo: " 14504 ", coeficiente: " 2.05 " })).toEqual({
      costo: "14504",
      coeficiente: "2.05",
    });
  });
});
