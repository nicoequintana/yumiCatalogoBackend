import ExcelJS from "exceljs";
import { COLUMNAS_ACTUALIZACION, NOMBRE_HOJA } from "./importProductos.js";
import { aplicarValidaciones } from "./plantillaProductos.js";

/**
 * Exportación del catálogo a `.xlsx`, para el flujo de ACTUALIZACIÓN masiva
 * por SKU (`GET /products/export` -> editar a mano -> `POST
 * /products/actualizar-masivo`).
 *
 * Es la contracara exacta de `importProductos.js`: donde ese módulo lee un
 * `.xlsx` y produce datos de producto, este toma un producto y produce la
 * fila de `.xlsx` que, leída de nuevo, tiene que devolver el mismo dato.
 *
 * **Desde el 25/08/2026 son cuatro columnas: `sku`, `nombre`, `precio` y
 * `stock`.** El archivo existe para retocar precios y stock de un catálogo ya
 * cargado; las dieciséis columnas anteriores obligaban a scrollear entre
 * textos largos para llegar al número que se quería cambiar. Lo que NO viaja
 * en el archivo queda intacto al actualizar (ver `COLUMNAS_ACTUALIZACION` en
 * `importProductos.js`), así que este recorte es también la garantía de que
 * una subida no pisa la descripción ni el contenido comercial.
 */

/**
 * Convierte un producto al array de valores en el MISMO orden que
 * `COLUMNAS_ACTUALIZACION`.
 *
 * Función pura: no sabe nada de Prisma ni de Excel más allá del array que
 * devuelve.
 *
 * `precio` sale como `Number` y no como string para que Excel lo trate como
 * número de verdad — un string en la celda rompe la validación `whole` que
 * aplica `aplicarValidaciones` y deja el archivo con el aviso de "número
 * almacenado como texto" en cada fila.
 *
 * @param {{sku?: string, nombre?: string, precio?: unknown, stock?: number}} producto
 * @returns {Array<string|number|null>}
 */
export function productoAFila(producto) {
  return [
    producto.sku ?? "",
    producto.nombre ?? "",
    producto.precio === null || producto.precio === undefined ? null : Number(producto.precio),
    producto.stock ?? 0,
  ];
}

/**
 * Genera el buffer del `.xlsx` de exportación: una sola hoja `Productos`, con
 * encabezado `COLUMNAS_ACTUALIZACION` y UNA FILA POR PRODUCTO real (no una
 * fila de ejemplo, a diferencia de `generarPlantilla`).
 *
 * **Ya no lleva la hoja `Listas`**: alimentaba los desplegables de `categoria`
 * y `etiqueta`, y esas dos columnas dejaron de existir en este archivo. Una
 * hoja oculta con datos que ningún desplegable referencia es peso muerto que
 * confunde a quien abra el archivo.
 *
 * Las validaciones se acotan al rango real de filas (2..productos.length+1) en
 * vez de `MAX_FILAS`: acá se conoce de antemano cuántas filas va a tener.
 *
 * @param {object[]} productos productos con `sku`, `nombre`, `precio` y `stock`
 * @returns {Promise<Buffer>}
 */
export async function generarExportacion(productos) {
  const wb = new ExcelJS.Workbook();

  const hoja = wb.addWorksheet(NOMBRE_HOJA);
  hoja.addRow(COLUMNAS_ACTUALIZACION);
  hoja.getRow(1).font = { bold: true };
  hoja.columns = COLUMNAS_ACTUALIZACION.map((columna) => ({ width: columna.length + 14 }));

  for (const producto of productos) {
    hoja.addRow(productoAFila(producto));
  }

  // `0` categorías: sin la hoja `Listas` no hay rango al que apuntar, y
  // `aplicarValidaciones` ya omite el desplegable de categoría con ese valor.
  // Las columnas `categoria`/`etiqueta` tampoco están en `COLUMNAS_ACTUALIZACION`,
  // así que se saltean solas.
  aplicarValidaciones(hoja, 0, COLUMNAS_ACTUALIZACION, productos.length + 1);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
