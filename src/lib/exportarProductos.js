import ExcelJS from "exceljs";
import { COLUMNAS_ACTUALIZACION, NOMBRE_HOJA } from "./importProductos.js";
import { aplicarValidaciones } from "./plantillaProductos.js";
import { sanitizarCelda } from "./sanitizarCelda.js";

/**
 * Exportación del catálogo a `.xlsx`, para el flujo de ACTUALIZACIÓN masiva
 * por SKU (`GET /products/export` -> editar a mano -> `POST
 * /products/actualizar-masivo`).
 *
 * Es la contracara exacta de `importProductos.js`: donde ese módulo lee un
 * `.xlsx` y produce datos de producto, este toma un producto y produce la
 * fila de `.xlsx` que, leída de nuevo, tiene que devolver el mismo dato.
 *
 * **Desde el 31/08/2026 son cinco columnas: `sku`, `nombre`, `costo`,
 * `coeficiente` y `stock`.** Eran cuatro y la tercera era `precio`; el cambio
 * acompaña al precio de venta pasando a derivarse de `costo × coeficiente`, así
 * que la planilla trae ahora lo que lo GENERA en vez del resultado.
 *
 * Consecuencia que hay que tener presente: **este archivo ya no puede cambiar un
 * precio publicado.** Sube costos, y los productos quedan en `Difiere` hasta que
 * alguien aplique desde Costos y precios — con su tabla antes→después de por
 * medio, que es exactamente la revisión que una subida masiva más necesita.
 *
 * El recorte original (de dieciséis columnas a unas pocas) sigue vigente por su
 * propio motivo: lo que NO viaja en el archivo queda intacto al actualizar (ver
 * `COLUMNAS_ACTUALIZACION` en `importProductos.js`), así que es la garantía de
 * que una subida no pisa la descripción ni el contenido comercial.
 */

/**
 * Convierte un producto al array de valores en el MISMO orden que
 * `COLUMNAS_ACTUALIZACION`.
 *
 * Función pura: no sabe nada de Prisma ni de Excel más allá del array que
 * devuelve.
 *
 * `costo` y `coeficiente` salen como `Number` y no como string para que Excel
 * los trate como números de verdad — un string en la celda rompe la validación
 * que aplica `aplicarValidaciones` y deja el archivo con el aviso de "número
 * almacenado como texto" en cada fila.
 *
 * **Un producto sin coeficiente cargado sale con el neutro, no en blanco.** Los
 * históricos previos a esta feature tienen la columna en `null`, y una celda
 * vacía volvería como el mismo neutro al releerla: emitirlo explícito hace que
 * el round-trip sea una identidad de verdad y que el admin vea con qué margen
 * está trabajando ese producto en vez de tener que adivinarlo.
 *
 * @param {{sku?: string, nombre?: string, costo?: unknown, coeficiente?: unknown, stock?: number}} producto
 * @returns {Array<string|number|null>}
 */
export function productoAFila(producto) {
  const numeroONulo = (valor) =>
    valor === null || valor === undefined ? null : Number(valor);

  return [
    // El `sku` NO se sanitiza: es la clave de matcheo del round-trip con
    // `POST /products/actualizar-masivo`, y un apóstrofo antepuesto rompería el
    // matcheo. El `nombre` sí, porque es texto libre que abre Excel.
    producto.sku ?? "",
    sanitizarCelda(producto.nombre ?? ""),
    numeroONulo(producto.costo),
    numeroONulo(producto.coeficiente) ?? 1,
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
