import ExcelJS from "exceljs";
import { sanitizarCelda } from "./sanitizarCelda.js";

/**
 * Exportación a `.xlsx` de la grilla de productos solicitados
 * (`GET /api/ordenes/productos-solicitados/export`).
 *
 * **Es un REPORTE, no una planilla que vuelva a subirse.** Por eso vive en su
 * propio archivo y no dentro de `exportarProductos.js`: ese módulo tiene un
 * contrato de round-trip con `POST /products/actualizar-masivo` — sus columnas
 * son `COLUMNAS_ACTUALIZACION` y lo que sale tiene que poder volver a entrar.
 * Meterle un segundo formato rompería esa garantía, que es justo la que impide
 * que una subida vacíe campos del catálogo.
 *
 * Los encabezados son legibles (con mayúsculas y acentos) porque nadie los
 * parsea de vuelta: los lee una persona.
 */

/** Encabezado del reporte, en el orden en que `filaSolicitada` emite los valores. */
export const COLUMNAS_SOLICITADOS = ["SKU", "Producto", "Unidades", "Órdenes", "Facturación"];

const NOMBRE_HOJA_SOLICITADOS = "Productos solicitados";

/** Lo que se escribe en la celda de SKU cuando el producto ya no existe. */
const SIN_SKU = "—";

/**
 * Convierte una fila del reporte al array de valores en el MISMO orden que
 * `COLUMNAS_SOLICITADOS`. Función pura.
 *
 * `unidades`, `ordenes` y `facturacion` salen como `Number` y no como string:
 * un string en la celda deja el aviso de "número almacenado como texto" en
 * cada fila y rompe cualquier suma que la persona haga en Excel. La
 * facturación llega como string entero desde la API (serializada con
 * `.toFixed(0)`, ver "Montos enteros"), así que `Number()` no pierde
 * precisión — no hay decimales que perder.
 *
 * @param {{sku: string|null, nombre: string, unidades: number, ordenes: number, facturacion: string}} solicitado
 * @returns {Array<string|number>}
 */
export function filaSolicitada(solicitado) {
  return [
    solicitado.sku ?? SIN_SKU,
    // `nombre` es el snapshot `nombreProducto`, texto libre: se fuerza a texto
    // para que un `=...` no se ejecute como fórmula al abrir el reporte.
    sanitizarCelda(solicitado.nombre ?? ""),
    solicitado.unidades ?? 0,
    solicitado.ordenes ?? 0,
    Number(solicitado.facturacion ?? 0),
  ];
}

/**
 * Genera el buffer del `.xlsx`: una sola hoja, encabezado y una fila por
 * producto solicitado.
 *
 * Sin filas sigue emitiendo un archivo válido con solo el encabezado — que es
 * la respuesta honesta a "todavía nadie pidió nada", en vez de un archivo
 * corrupto o un error.
 *
 * @param {object[]} solicitados filas ya agrupadas por el controller
 * @returns {Promise<Buffer>}
 */
export async function generarExportacionSolicitados(solicitados) {
  const wb = new ExcelJS.Workbook();

  const hoja = wb.addWorksheet(NOMBRE_HOJA_SOLICITADOS);
  hoja.addRow(COLUMNAS_SOLICITADOS);
  hoja.getRow(1).font = { bold: true };
  hoja.columns = COLUMNAS_SOLICITADOS.map((columna) => ({ width: columna.length + 14 }));

  for (const solicitado of solicitados) {
    hoja.addRow(filaSolicitada(solicitado));
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
