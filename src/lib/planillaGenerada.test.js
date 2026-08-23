import { describe, expect, it } from "vitest";
import { construirPlanilla, validarRedacciones } from "./planillaGenerada.js";
import { COLUMNAS, leerArchivo } from "./importProductos.js";

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

  it("rechaza especificaciones/camposFaltantes/fotosSugeridas cuando son null", () => {
    const errores = validarRedacciones([
      { ...VALIDA, especificaciones: null, camposFaltantes: null, fotosSugeridas: null },
    ]);
    expect(errores.some((error) => /especificaciones/.test(error))).toBe(true);
    expect(errores.some((error) => /camposFaltantes/.test(error))).toBe(true);
    expect(errores.some((error) => /fotosSugeridas/.test(error))).toBe(true);
  });

  it("rechaza una categoría que no existe cuando se pasan las vigentes", () => {
    const errores = validarRedacciones([{ ...VALIDA, categoria: "Iluminación y Lámparas" }], {
      categoriasVigentes: ["Iluminación", "Deco"],
    });
    expect(errores.some((error) => /Iluminación y Lámparas/.test(error))).toBe(true);
  });

  it("acepta la categoría sin importar mayúsculas, igual que el importador", () => {
    const errores = validarRedacciones([{ ...VALIDA, categoria: "iluminación" }], {
      categoriasVigentes: ["Iluminación"],
    });
    expect(errores).toEqual([]);
  });

  it("sin categoriasVigentes no valida categoría (compatibilidad hacia atrás)", () => {
    expect(validarRedacciones([{ ...VALIDA, categoria: "Lo que sea" }])).toEqual([]);
  });
});

async function aBuffer(workbook) {
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("construirPlanilla", () => {
  it("usa exactamente las columnas del importador, en su orden", async () => {
    const wb = await construirPlanilla([VALIDA]);
    const encabezado = wb.getWorksheet("Productos").getRow(1).values.slice(1);
    // Este test ata las dos puntas: si el importador agrega una columna y esto
    // no, el archivo generado deja de ser importable en silencio.
    expect(encabezado).toEqual(COLUMNAS);
  });

  it("el archivo generado lo puede leer el importador", async () => {
    const wb = await construirPlanilla([{ ...VALIDA, precio: undefined }]);
    const filas = await leerArchivo(await aBuffer(wb));

    expect(filas).toHaveLength(1);
    expect(filas[0].valores.nombre).toBe("Lámpara Nómade");
  });

  it("escribe las listas con un ítem por renglón", async () => {
    const wb = await construirPlanilla([{ ...VALIDA, beneficios: ["Uno", "Dos"] }]);
    const filas = await leerArchivo(await aBuffer(wb));

    expect(filas[0].valores.beneficios).toBe("Uno\nDos");
  });

  it("escribe las especificaciones como 'Nombre: Valor' por renglón", async () => {
    const wb = await construirPlanilla([
      { ...VALIDA, especificaciones: [{ nombre: "Material", valor: "Aluminio" }] },
    ]);
    const filas = await leerArchivo(await aBuffer(wb));

    expect(filas[0].valores.especificaciones).toBe("Material: Aluminio");
  });

  it("deja el precio vacío para forzar la revisión humana", async () => {
    const wb = await construirPlanilla([VALIDA]);
    const filas = await leerArchivo(await aBuffer(wb));

    expect(filas[0].valores.precio ?? "").toBe("");
  });

  it("agrega una hoja Referencia que el importador ignora", async () => {
    const wb = await construirPlanilla([{ ...VALIDA, precioMLReferencia: 48900, camposFaltantes: ["usos"] }]);

    expect(wb.getWorksheet("Referencia")).toBeDefined();
    // El importador selecciona por nombre, así que la hoja extra no lo afecta.
    const filas = await leerArchivo(await aBuffer(wb));
    expect(filas).toHaveLength(1);
  });

  it("construirPlanilla tolera null en las listas aunque el validador ya lo rechace", async () => {
    // Defensa en profundidad: si un caller futuro saltea la validación, la
    // planilla degrada a celdas vacías en vez de reventar el lote entero.
    const wb = await construirPlanilla([
      { ...VALIDA, especificaciones: null, camposFaltantes: null, fotosSugeridas: null },
    ]);
    expect(wb.getWorksheet("Productos")).toBeDefined();
  });

  it("la hoja Referencia lleva url y revisar cuando vienen en la redacción", async () => {
    const wb = await construirPlanilla([
      { ...VALIDA, url: "https://articulo.mercadolibre.com.ar/MLA-1", revisar: "sin id de ML" },
    ]);
    const fila = wb.getWorksheet("Referencia").getRow(2).values;
    expect(fila).toContain("https://articulo.mercadolibre.com.ar/MLA-1");
    expect(fila).toContain("sin id de ML");
  });
});
