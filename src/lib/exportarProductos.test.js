import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { COLUMNAS_ACTUALIZACION, leerArchivo, validarFilaActualizacion } from "./importProductos.js";
import { generarExportacion, productoAFila } from "./exportarProductos.js";

function productoDePrueba(extra = {}) {
  return {
    id: 42,
    sku: "VEL-1234",
    nombre: "Vela de soja",
    costo: 1500,
    coeficiente: 2.05,
    stock: 12,
    ...extra,
  };
}

async function abrir(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

describe("productoAFila", () => {
  it("mapea el producto al orden de COLUMNAS_ACTUALIZACION", () => {
    const fila = productoAFila(productoDePrueba());

    expect(fila).toEqual(["VEL-1234", "Vela de soja", 1500, 2.05, 12]);
  });

  // Cuatro columnas y cuatro valores: si esto se desalinea, el archivo escribe
  // cada dato debajo del encabezado equivocado sin que nada falle.
  it("emite exactamente tantos valores como columnas tiene el archivo", () => {
    expect(productoAFila(productoDePrueba())).toHaveLength(COLUMNAS_ACTUALIZACION.length);
  });

  it("no filtra ningún campo que la planilla no deba traer", () => {
    const fila = productoAFila(
      productoDePrueba({ descripcion: "texto largo", etiqueta: "Nuevo", categoria: { nombre: "Velas" } }),
    );

    expect(fila).toEqual(["VEL-1234", "Vela de soja", 1500, 2.05, 12]);
  });

  it("emite costo y coeficiente como number, no como string", () => {
    // Un string en la celda rompe la validación de Excel y deja el aviso de
    // "número almacenado como texto" en cada fila.
    const fila = productoAFila(productoDePrueba({ costo: "1500", coeficiente: "2.05" }));

    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("costo")]).toBe(1500);
    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("coeficiente")]).toBe(2.05);
  });

  it("un producto sin coeficiente sale con el neutro, no en blanco", () => {
    // Los históricos previos a esta feature tienen la columna en null. Una
    // celda vacía volvería como el mismo 1 al releerla, así que emitirlo
    // explícito hace del round-trip una identidad de verdad — y le muestra al
    // admin con qué margen está trabajando en vez de hacérselo adivinar.
    const fila = productoAFila(productoDePrueba({ coeficiente: null }));

    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("coeficiente")]).toBe(1);
  });

  it("tolera un producto sin stock declarado", () => {
    expect(productoAFila({ sku: "X", nombre: "Y", costo: 1 })).toEqual(["X", "Y", 1, 1, 0]);
  });
});

describe("generarExportacion", () => {
  it("escribe el encabezado de COLUMNAS_ACTUALIZACION y una fila por producto", async () => {
    const wb = await abrir(await generarExportacion([productoDePrueba(), productoDePrueba({ sku: "VEL-2" })]));
    const hoja = wb.getWorksheet("Productos");

    COLUMNAS_ACTUALIZACION.forEach((columna, indice) => {
      expect(hoja.getRow(1).getCell(indice + 1).value).toBe(columna);
    });
    expect(hoja.rowCount).toBe(3); // encabezado + 2 productos
  });

  // La hoja `Listas` alimentaba los desplegables de `categoria` y `etiqueta`,
  // y esas columnas dejaron de existir en este archivo (25/08/2026). Una hoja
  // oculta con datos que ningún desplegable referencia es peso muerto.
  it("ya no incluye la hoja Listas", async () => {
    const wb = await abrir(await generarExportacion([productoDePrueba()]));

    expect(wb.getWorksheet("Listas")).toBeUndefined();
    expect(wb.worksheets).toHaveLength(1);
  });

  it("valida costo y stock como enteros, y el coeficiente como decimal", async () => {
    const wb = await abrir(await generarExportacion([productoDePrueba()]));
    const hoja = wb.getWorksheet("Productos");

    const costo = hoja.getCell(2, COLUMNAS_ACTUALIZACION.indexOf("costo") + 1).dataValidation;
    expect(costo.type).toBe("whole");
    expect(costo.operator).toBe("greaterThan");

    // `decimal` y no `whole`: es el único campo con decimales del sistema.
    const coef = hoja.getCell(2, COLUMNAS_ACTUALIZACION.indexOf("coeficiente") + 1).dataValidation;
    expect(coef.type).toBe("decimal");

    const stock = hoja.getCell(2, COLUMNAS_ACTUALIZACION.indexOf("stock") + 1).dataValidation;
    expect(stock.type).toBe("whole");
    expect(stock.operator).toBe("greaterThanOrEqual");
  });

  it("no rompe con el catálogo vacío", async () => {
    const wb = await abrir(await generarExportacion([]));

    expect(wb.getWorksheet("Productos").rowCount).toBe(1);
  });
});

/**
 * El test que más importa de este módulo: lo que se exporta tiene que poder
 * volver a leerse y dar el mismo dato. Es la única garantía real de que
 * `productoAFila` y `validarFilaActualizacion` no se desincronicen — viven en
 * archivos distintos y nada más los ata.
 */
describe("generarExportacion — round trip", () => {
  it("lo que genera se vuelve a leer idéntico", async () => {
    const producto = productoDePrueba();
    const buffer = await generarExportacion([producto]);

    const filas = await leerArchivo(buffer, COLUMNAS_ACTUALIZACION);
    expect(filas).toHaveLength(1);

    const { datos, id, errores } = validarFilaActualizacion(
      filas[0].valores,
      filas[0].numeroFila,
      new Map([[producto.sku, producto.id]]),
    );

    expect(errores).toEqual([]);
    expect(id).toBe(producto.id);
    expect(datos).toEqual({
      nombre: producto.nombre,
      costo: String(producto.costo),
      coeficiente: String(producto.coeficiente),
      stock: producto.stock,
    });
  });

  it("un producto con stock 0 sobrevive la ida y vuelta sin volverse error", async () => {
    // `stock` es obligatorio al actualizar, así que un 0 exportado como celda
    // vacía volvería como error de fila. Tiene que viajar como 0 explícito.
    const producto = productoDePrueba({ stock: 0 });
    const buffer = await generarExportacion([producto]);

    const filas = await leerArchivo(buffer, COLUMNAS_ACTUALIZACION);
    const { datos, errores } = validarFilaActualizacion(
      filas[0].valores,
      filas[0].numeroFila,
      new Map([[producto.sku, producto.id]]),
    );

    expect(errores).toEqual([]);
    expect(datos.stock).toBe(0);
  });
});
