import ExcelJS from "exceljs";
import { COLUMNAS_ACTUALIZACION, NOMBRE_HOJA, serializarEspecificaciones, serializarLista } from "./importProductos.js";
import { aplicarValidaciones, construirHojaListas } from "./plantillaProductos.js";

/**
 * Exportación del catálogo a `.xlsx`, para el flujo de ACTUALIZACIÓN masiva
 * por SKU (`GET /products/export` -> editar a mano -> `POST
 * /products/actualizar-masivo`).
 *
 * Es la contracara exacta de `importProductos.js`: donde ese módulo lee un
 * `.xlsx` y produce datos de producto, este toma un producto y produce la
 * fila de `.xlsx` que, leída de nuevo, tiene que devolver el mismo dato. Por
 * eso las listas y especificaciones se serializan con `serializarLista`/
 * `serializarEspecificaciones` (las inversas exactas de `parsearLista`/
 * `parsearEspecificaciones`, ambas en `importProductos.js`) en vez de
 * reimplementar el formato del separador acá.
 */

/**
 * Convierte un producto (con sus relaciones ya cargadas y las listas
 * agrupadas por tipo) al array de valores en el MISMO orden que
 * `COLUMNAS_ACTUALIZACION`.
 *
 * Función pura: no sabe nada de Prisma ni de Excel más allá del array que
 * devuelve. El caller (`generarExportacion`, o el controller antes de
 * llamarlo) es quien agrupa `listas` en `beneficios`/`usos`/`idealPara`/
 * `incluye` — mismo criterio de agrupación que `agruparListasPorTipo` en
 * `products.mapper.js`, pero no se comparte ese helper porque es privado a
 * ese módulo y este archivo no depende de Prisma.
 *
 * @param {object} producto
 * @returns {Array<string|number|null>}
 */
export function productoAFila(producto) {
  return [
    producto.sku ?? "",
    producto.nombre ?? "",
    producto.descripcion ?? "",
    producto.precio === null || producto.precio === undefined ? null : Number(producto.precio),
    producto.stock ?? 0,
    producto.categoria?.nombre ?? null,
    producto.etiqueta ?? null,
    producto.fraseComercial ?? null,
    producto.porQueLoVasAQuerer ?? null,
    producto.tePasaEsto ?? null,
    serializarLista(producto.caracteristicas),
    serializarLista(producto.beneficios),
    serializarLista(producto.usos),
    serializarLista(producto.idealPara),
    serializarLista(producto.incluye),
    serializarEspecificaciones(producto.especificaciones),
  ];
}

/**
 * Genera el buffer del `.xlsx` de exportación: misma hoja `Listas` con
 * categorías y etiquetas sugeridas que la plantilla de alta, y la hoja
 * `Productos` con encabezado `COLUMNAS_ACTUALIZACION` y UNA FILA POR
 * PRODUCTO real (no una fila de ejemplo, a diferencia de `generarPlantilla`).
 *
 * Reusa `aplicarValidaciones` para los mismos desplegables/validaciones de
 * Excel que la plantilla de alta, pero acotados al rango real de filas
 * (2..productos.length+1) en vez de `MAX_FILAS`: acá se conoce de antemano
 * cuántas filas va a tener el archivo.
 *
 * @param {object[]} productos productos con relaciones ya cargadas y listas agrupadas (ver `productoAFila`)
 * @param {string[]} categorias nombres de categoría existentes
 * @returns {Promise<Buffer>}
 */
export async function generarExportacion(productos, categorias) {
  const wb = new ExcelJS.Workbook();

  // Oculta a propósito: alimenta los desplegables de categoría/etiqueta (la
  // fórmula de `aplicarValidaciones` sigue apuntando acá aunque no se vea),
  // pero acá el admin solo tiene que ver sus productos, no la hoja de apoyo
  // que sí es visible en la plantilla de alta. `"hidden"` (no `"veryHidden"`):
  // se puede recuperar con click derecho en la barra de pestañas > Mostrar,
  // si alguna vez hace falta revisarla.
  construirHojaListas(wb, categorias).state = "hidden";

  const hoja = wb.addWorksheet(NOMBRE_HOJA);
  hoja.addRow(COLUMNAS_ACTUALIZACION);
  hoja.getRow(1).font = { bold: true };
  hoja.columns = COLUMNAS_ACTUALIZACION.map((columna) => ({ width: columna.length + 14 }));

  for (const producto of productos) {
    hoja.addRow(productoAFila(producto));
  }

  aplicarValidaciones(hoja, categorias.length, COLUMNAS_ACTUALIZACION, productos.length + 1);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
