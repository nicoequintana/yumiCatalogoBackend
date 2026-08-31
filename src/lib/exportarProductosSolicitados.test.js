import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  COLUMNAS_SOLICITADOS,
  filaSolicitada,
  generarExportacionSolicitados,
} from "./exportarProductosSolicitados.js";

/**
 * Exportación de la grilla de productos solicitados.
 *
 * El archivo es un REPORTE, no una planilla que se vuelva a subir (a
 * diferencia de `exportarProductos.js`, que tiene contrato de round-trip con
 * `POST /products/actualizar-masivo`). Igual se lo verifica leyendo el buffer
 * de vuelta: es la única forma de afirmar sobre lo que realmente queda escrito
 * en las celdas y no sobre lo que el código creyó escribir.
 */

async function leerHoja(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const hoja = wb.worksheets[0];
  const filas = [];
  hoja.eachRow((fila) => {
    // `values` de ExcelJS es 1-based: el índice 0 viene vacío siempre.
    filas.push(fila.values.slice(1));
  });
  return { hoja, filas };
}

function fila(overrides = {}) {
  return {
    productId: 7,
    sku: "YIMA-MATE-1234",
    nombre: "Mate imperial",
    unidades: 5,
    ordenes: 2,
    facturacion: "45000",
    ...overrides,
  };
}

describe("filaSolicitada", () => {
  it("emite los valores en el mismo orden que COLUMNAS_SOLICITADOS", () => {
    expect(filaSolicitada(fila())).toEqual(["YIMA-MATE-1234", "Mate imperial", 5, 2, 45000]);
  });

  it("marca con guion el producto borrado, que ya no tiene SKU", () => {
    expect(filaSolicitada(fila({ productId: null, sku: null }))[0]).toBe("—");
  });

  it("escribe unidades y facturacion como numeros, no como texto", () => {
    const [, , unidades, ordenes, facturacion] = filaSolicitada(fila());
    expect(typeof unidades).toBe("number");
    expect(typeof ordenes).toBe("number");
    expect(typeof facturacion).toBe("number");
  });

  // El nombre es texto libre (snapshot de `nombreProducto`): un `=...` se
  // ejecutaría como fórmula al abrir el reporte. Se fuerza a texto.
  it("antepone un apóstrofo a un nombre de producto que parece una fórmula", () => {
    expect(filaSolicitada(fila({ nombre: "=1+1" }))[1]).toBe("'=1+1");
  });
});

describe("generarExportacionSolicitados", () => {
  it("escribe el encabezado y una fila por producto", async () => {
    const buffer = await generarExportacionSolicitados([
      fila(),
      fila({ productId: 9, sku: "YIMA-TERMO-9999", nombre: "Termo", unidades: 1, ordenes: 1, facturacion: "9000" }),
    ]);

    const { filas } = await leerHoja(buffer);

    expect(filas[0]).toEqual(COLUMNAS_SOLICITADOS);
    expect(filas).toHaveLength(3);
    expect(filas[1]).toEqual(["YIMA-MATE-1234", "Mate imperial", 5, 2, 45000]);
    expect(filas[2]).toEqual(["YIMA-TERMO-9999", "Termo", 1, 1, 9000]);
  });

  it("genera un archivo valido cuando no hay nada solicitado", async () => {
    const buffer = await generarExportacionSolicitados([]);

    const { filas } = await leerHoja(buffer);

    expect(filas).toEqual([COLUMNAS_SOLICITADOS]);
  });
});
