import { describe, expect, it } from "vitest";
import { parsearLista, parsearEspecificaciones, validarFila } from "./importProductos.js";

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

const CATEGORIAS = new Map([
  ["velas", 7],
  ["bazar", 9],
]);

function filaValida(extra = {}) {
  return { nombre: "Vela de soja", descripcion: "Aroma lavanda", precio: 1500, ...extra };
}

describe("validarFila", () => {
  it("mapea una fila mínima válida, con stock 0 por defecto", () => {
    const { datos, errores } = validarFila(filaValida(), 2, CATEGORIAS);

    expect(errores).toEqual([]);
    expect(datos).toEqual({
      nombre: "Vela de soja",
      descripcion: "Aroma lavanda",
      precio: "1500",
      stock: 0,
      etiqueta: null,
      categoriaId: null,
      fraseComercial: null,
      porQueLoVasAQuerer: null,
      tePasaEsto: null,
      caracteristicas: [],
      beneficios: [],
      usos: [],
      idealPara: [],
      incluye: [],
      especificaciones: [],
    });
  });

  it("resuelve la categoría a su id, sin distinguir mayúsculas ni espacios", () => {
    const { datos, errores } = validarFila(filaValida({ categoria: "  VELAS " }), 2, CATEGORIAS);

    expect(errores).toEqual([]);
    expect(datos.categoriaId).toBe(7);
  });

  it("rechaza una categoría inexistente con fila y columna", () => {
    const { datos, errores } = validarFila(filaValida({ categoria: "Bazr" }), 12, CATEGORIAS);

    expect(datos).toBeNull();
    expect(errores).toEqual([
      { fila: 12, columna: "categoria", valor: "Bazr", motivo: "La categoría no existe." },
    ]);
  });

  it("rechaza nombre y descripción vacíos", () => {
    const { errores } = validarFila({ nombre: "   ", descripcion: "", precio: 100 }, 3, CATEGORIAS);

    expect(errores).toEqual([
      { fila: 3, columna: "nombre", valor: "   ", motivo: "El nombre es obligatorio." },
      { fila: 3, columna: "descripcion", valor: "", motivo: "La descripción es obligatoria." },
    ]);
  });

  it("acumula TODOS los errores de la fila, no corta en el primero", () => {
    const { errores } = validarFila({ nombre: "", descripcion: "", precio: "abc" }, 5, CATEGORIAS);

    expect(errores).toHaveLength(3);
    expect(errores.map((e) => e.columna)).toEqual(["nombre", "descripcion", "precio"]);
  });

  it("rechaza precio no numérico, cero o negativo", () => {
    for (const precio of ["abc", 0, -5]) {
      const { errores } = validarFila(filaValida({ precio }), 4, CATEGORIAS);
      expect(errores).toEqual([
        { fila: 4, columna: "precio", valor: precio, motivo: "El precio debe ser un número mayor a 0." },
      ]);
    }
  });

  it("acepta el precio como texto con coma decimal (Excel en configuración regional)", () => {
    const { datos, errores } = validarFila(filaValida({ precio: "1500,50" }), 2, CATEGORIAS);

    expect(errores).toEqual([]);
    expect(datos.precio).toBe("1500.50");
  });

  it("rechaza stock negativo o no entero", () => {
    expect(validarFila(filaValida({ stock: -1 }), 6, CATEGORIAS).errores).toEqual([
      { fila: 6, columna: "stock", valor: -1, motivo: "El stock debe ser un número entero mayor o igual a 0." },
    ]);
    expect(validarFila(filaValida({ stock: 2.5 }), 6, CATEGORIAS).errores).toHaveLength(1);
  });

  it("convierte un error de especificaciones en un error de fila", () => {
    const { datos, errores } = validarFila(filaValida({ especificaciones: "Material ABS" }), 8, CATEGORIAS);

    expect(datos).toBeNull();
    expect(errores).toEqual([
      {
        fila: 8,
        columna: "especificaciones",
        valor: "Material ABS",
        motivo:
          'Cada especificación debe tener el formato "Nombre: Valor". Renglón inválido: "Material ABS".',
      },
    ]);
  });

  it("mapea todos los campos opcionales cuando vienen completos", () => {
    const { datos } = validarFila(
      filaValida({
        stock: 12,
        categoria: "Velas",
        etiqueta: "Nuevo",
        fraseComercial: "Iluminá tu casa",
        porQueLoVasAQuerer: "Porque dura",
        tePasaEsto: "Se te corta la luz",
        caracteristicas: "Cera de soja",
        beneficios: "Dura 40 h\nSin humo",
        usos: "Living",
        idealPara: "Regalo",
        incluye: "1 vela",
        especificaciones: "Material: Soja",
      }),
      2,
      CATEGORIAS,
    );

    expect(datos.stock).toBe(12);
    expect(datos.categoriaId).toBe(7);
    expect(datos.etiqueta).toBe("Nuevo");
    expect(datos.fraseComercial).toBe("Iluminá tu casa");
    expect(datos.beneficios).toEqual([{ texto: "Dura 40 h" }, { texto: "Sin humo" }]);
    expect(datos.especificaciones).toEqual([{ nombre: "Material", valor: "Soja" }]);
  });
});
