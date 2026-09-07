import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { COLUMNAS, MARCA_EJEMPLO, leerArchivo } from "./importProductos.js";
import { generarPlantilla } from "./plantillaProductos.js";

async function abrir(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

describe("generarPlantilla", () => {
  it("crea las hojas Productos y Listas", async () => {
    const wb = await abrir(await generarPlantilla(["Velas", "Bazar"]));

    expect(wb.getWorksheet("Productos")).toBeDefined();
    expect(wb.getWorksheet("Listas")).toBeDefined();
  });

  it("escribe los encabezados en el orden de COLUMNAS", async () => {
    const wb = await abrir(await generarPlantilla(["Velas"]));
    const encabezado = wb.getWorksheet("Productos").getRow(1);

    COLUMNAS.forEach((columna, indice) => {
      expect(encabezado.getCell(indice + 1).value).toBe(columna);
    });
  });

  it("vuelca las categorías recibidas en la hoja Listas", async () => {
    const wb = await abrir(await generarPlantilla(["Velas", "Bazar"]));
    const listas = wb.getWorksheet("Listas");

    expect(listas.getCell("A2").value).toBe("Velas");
    expect(listas.getCell("A3").value).toBe("Bazar");
  });

  it("vuelca las etiquetas recibidas en la hoja Listas", async () => {
    const etiquetas = ["Best Seller", "Nuevo"];
    const wb = await abrir(await generarPlantilla(["Velas"], etiquetas));
    const listas = wb.getWorksheet("Listas");

    etiquetas.forEach((etiqueta, indice) => {
      expect(listas.getCell(`B${indice + 2}`).value).toBe(etiqueta);
    });
  });

  it("pone un desplegable ESTRICTO en categoría, apuntando al rango de Listas", async () => {
    const wb = await abrir(await generarPlantilla(["Velas", "Bazar"]));
    const columna = COLUMNAS.indexOf("categoria") + 1;
    const validacion = wb.getWorksheet("Productos").getCell(2, columna).dataValidation;

    expect(validacion.type).toBe("list");
    expect(validacion.showErrorMessage).toBe(true);
    expect(validacion.formulae).toEqual(["Listas!$A$2:$A$3"]);
  });

  it("pone un desplegable ESTRICTO en etiqueta — es una tabla, lista cerrada", async () => {
    const wb = await abrir(await generarPlantilla(["Velas"], ["Nuevo", "Best Seller"]));
    const columna = COLUMNAS.indexOf("etiqueta") + 1;
    const validacion = wb.getWorksheet("Productos").getCell(2, columna).dataValidation;

    expect(validacion.type).toBe("list");
    expect(validacion.showErrorMessage).toBe(true);
    expect(validacion.formulae).toEqual(["Listas!$B$2:$B$3"]);
  });

  it("no rompe cuando no hay ninguna etiqueta cargada", async () => {
    const wb = await abrir(await generarPlantilla(["Velas"]));
    const columna = COLUMNAS.indexOf("etiqueta") + 1;

    expect(wb.getWorksheet("Productos").getCell(2, columna).dataValidation).toBeUndefined();
  });

  it("bloquea costos <= 0 o con decimales, y stock negativo o decimal", async () => {
    const wb = await abrir(await generarPlantilla(["Velas"]));
    const hoja = wb.getWorksheet("Productos");

    const costo = hoja.getCell(2, COLUMNAS.indexOf("costo") + 1).dataValidation;
    // `whole`, no `decimal`: la columna de la base es `Decimal(10, 0)` y el
    // importador rechaza los centavos. Que Excel los frene al tipearlos evita
    // descubrirlo con la planilla entera cargada.
    expect(costo.type).toBe("whole");
    expect(costo.operator).toBe("greaterThan");
    expect(costo.showErrorMessage).toBe(true);

    const stock = hoja.getCell(2, COLUMNAS.indexOf("stock") + 1).dataValidation;
    expect(stock.type).toBe("whole");
    expect(stock.operator).toBe("greaterThanOrEqual");
  });

  it("no rompe cuando no hay ninguna categoría cargada", async () => {
    const wb = await abrir(await generarPlantilla([]));
    const columna = COLUMNAS.indexOf("categoria") + 1;

    expect(wb.getWorksheet("Productos").getCell(2, columna).dataValidation).toBeUndefined();
  });

  it("incluye una fila de ejemplo marcada con MARCA_EJEMPLO, que el admin pisa o borra", async () => {
    const wb = await abrir(await generarPlantilla(["Velas"]));
    const ejemplo = wb.getWorksheet("Productos").getRow(2);

    const nombre = ejemplo.getCell(COLUMNAS.indexOf("nombre") + 1).value;
    expect(nombre).toBeTruthy();
    expect(String(nombre).startsWith(MARCA_EJEMPLO)).toBe(true);
    expect(ejemplo.getCell(COLUMNAS.indexOf("costo") + 1).value).toBeTypeOf("number");
  });

  it("ROUND-TRIP: la plantilla sin editar no deja ninguna fila de datos al leerla", async () => {
    // Guarda de regresión del defecto: si esto vuelve a dar 1, la fila de
    // ejemplo se está colando como producto real en el catálogo.
    const buffer = await generarPlantilla(["Velas"]);

    const filas = await leerArchivo(buffer);

    expect(filas).toHaveLength(0);
  });
});
