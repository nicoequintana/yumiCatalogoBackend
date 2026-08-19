import { describe, expect, it } from "vitest";
import { parsearLista, parsearEspecificaciones } from "./importProductos.js";

describe("parsearLista", () => {
  it("parte un texto multilínea en un ítem por renglón", () => {
    expect(parsearLista("Recargable por USB\nDura 8 horas")).toEqual([
      { texto: "Recargable por USB" },
      { texto: "Dura 8 horas" },
    ]);
  });

  it("descarta renglones vacíos y aplica trim", () => {
    expect(parsearLista("  Uno  \n\n   \nDos")).toEqual([{ texto: "Uno" }, { texto: "Dos" }]);
  });

  it("soporta saltos de línea de Windows (CRLF)", () => {
    expect(parsearLista("Uno\r\nDos")).toEqual([{ texto: "Uno" }, { texto: "Dos" }]);
  });

  it("devuelve lista vacía para celda vacía, null o undefined", () => {
    expect(parsearLista("")).toEqual([]);
    expect(parsearLista(null)).toEqual([]);
    expect(parsearLista(undefined)).toEqual([]);
  });

  it("NO parte por punto y coma — un ';' es texto legítimo del ítem", () => {
    expect(parsearLista("Recargable; también funciona con pilas")).toEqual([
      { texto: "Recargable; también funciona con pilas" },
    ]);
  });
});

describe("parsearEspecificaciones", () => {
  it("parte cada renglón en nombre y valor por el primer ':'", () => {
    expect(parsearEspecificaciones("Material: ABS\nPeso: 250 g")).toEqual([
      { nombre: "Material", valor: "ABS" },
      { nombre: "Peso", valor: "250 g" },
    ]);
  });

  it("parte solo en el PRIMER ':' — el valor puede contener más", () => {
    expect(parsearEspecificaciones("Horario: 9:00 a 18:00")).toEqual([
      { nombre: "Horario", valor: "9:00 a 18:00" },
    ]);
  });

  it("lanza si un renglón no tiene ':'", () => {
    expect(() => parsearEspecificaciones("Material ABS")).toThrow(
      'Cada especificación debe tener el formato "Nombre: Valor". Renglón inválido: "Material ABS".',
    );
  });

  it("lanza si el nombre está vacío", () => {
    expect(() => parsearEspecificaciones(": ABS")).toThrow('Renglón inválido: ": ABS".');
  });

  it("lanza si el valor está vacío", () => {
    expect(() => parsearEspecificaciones("Material:")).toThrow('Renglón inválido: "Material:".');
  });

  it("devuelve lista vacía para celda vacía", () => {
    expect(parsearEspecificaciones("")).toEqual([]);
    expect(parsearEspecificaciones(null)).toEqual([]);
  });
});
