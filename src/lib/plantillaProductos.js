import ExcelJS from "exceljs";
import { COLUMNAS, MARCA_EJEMPLO, MAX_FILAS, NOMBRE_HOJA } from "./importProductos.js";

export const HOJA_LISTAS = "Listas";

/** Última fila a la que se aplican las validaciones (el admin puede llenar hasta MAX_FILAS). */
const ULTIMA_FILA = MAX_FILAS + 1;

const FILA_EJEMPLO = {
  nombre: `${MARCA_EJEMPLO} — Vela de soja lavanda`,
  descripcion: "Vela artesanal de cera de soja con aroma a lavanda.",
  costo: 1500,
  // El precio de venta sale de `costo × coeficiente`: 1500 × 2,05 = 3.075.
  coeficiente: 2.05,
  stock: 10,
  fraseComercial: "Relajá tu casa en 30 segundos.",
  caracteristicas: "Cera de soja 100%\nMecha de algodón",
  beneficios: "Dura 40 horas\nNo genera humo",
  especificaciones: "Material: Cera de soja\nPeso: 250 g",
};

/**
 * Genera el buffer del `.xlsx` de plantilla, con los desplegables poblados a
 * partir de las categorías que existen en la base EN ESE MOMENTO.
 *
 * Los desplegables apuntan a un rango de la hoja `Listas` en vez de a una lista
 * inline (`'"a,b,c"'`): la lista inline tiene un techo de ~255 caracteres que un
 * catálogo con muchas categorías supera, y la referencia de rango no lo tiene.
 *
 * OJO: el desplegable es una ayuda, no una garantía. Excel permite pegar
 * (Ctrl+V) por encima de una celda con validación, salteándola sin aviso, y el
 * archivo puede editarse en Google Sheets. El backend revalida todo al importar.
 *
 * @param {string[]} categorias nombres de categoría existentes
 * @param {string[]} [etiquetas] nombres de etiqueta existentes (la tabla `Etiqueta`, lista cerrada)
 * @returns {Promise<Buffer>}
 */
export async function generarPlantilla(categorias, etiquetas = []) {
  const wb = new ExcelJS.Workbook();

  construirHojaListas(wb, categorias, etiquetas);

  const hoja = wb.addWorksheet(NOMBRE_HOJA);
  hoja.addRow(COLUMNAS);
  hoja.getRow(1).font = { bold: true };
  hoja.columns = COLUMNAS.map((columna) => ({ width: columna.length + 14 }));
  hoja.addRow(COLUMNAS.map((columna) => FILA_EJEMPLO[columna] ?? null));

  aplicarValidaciones(hoja, categorias.length, COLUMNAS, ULTIMA_FILA, etiquetas.length);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Arma la hoja `Listas` con las categorías y las etiquetas que alimentan los
 * desplegables de la hoja `Productos`. Compartida por la plantilla de alta
 * (`generarPlantilla`) y la exportación para actualización masiva
 * (`exportarProductos.js`) — las dos necesitan exactamente los mismos dos
 * desplegables.
 *
 * Las etiquetas ya NO son una lista sugerida escrita a mano acá: desde que
 * `Etiqueta` es una tabla, salen de la base (mismo criterio que `categorias`).
 */
export function construirHojaListas(wb, categorias, etiquetas = []) {
  const listas = wb.addWorksheet(HOJA_LISTAS);
  listas.getCell("A1").value = "Categorías";
  listas.getCell("B1").value = "Etiquetas";
  categorias.forEach((nombre, indice) => {
    listas.getCell(`A${indice + 2}`).value = nombre;
  });
  etiquetas.forEach((nombre, indice) => {
    listas.getCell(`B${indice + 2}`).value = nombre;
  });
  return listas;
}

/**
 * Aplica las validaciones de Excel a todo el rango editable de cada columna.
 *
 * `columnas` generaliza el cálculo de índice para que sirva tanto para
 * `COLUMNAS` (alta, quince columnas) como para `COLUMNAS_ACTUALIZACION`
 * (actualización, cuatro columnas con `sku` primero). `ultimaFila` generaliza
 * el rango de filas: la plantilla de alta cubre hasta `MAX_FILAS` (el admin
 * todavía no sabe cuántas va a cargar), pero la exportación para actualizar
 * conoce de antemano la cantidad exacta de productos y no tiene sentido
 * validar miles de filas vacías de más.
 *
 * **Una columna que no esté en `columnas` se saltea en silencio.** Hace falta
 * desde que `COLUMNAS_ACTUALIZACION` dejó de ser un superset de `COLUMNAS`
 * (25/08/2026): la exportación no tiene `categoria` ni `etiqueta`, y sin esta
 * guarda `indexOf` devuelve `-1`, el `+ 1` lo convierte en `0`, y
 * `hoja.getCell(fila, 0)` es una celda que no existe. El salteo es silencioso
 * a propósito: no es un error configurar menos columnas, es el caso de uso.
 *
 * `cantidadEtiquetas` es un parámetro aparte (no comparte `cantidadCategorias`)
 * porque las dos listas crecen distinto: la exportación de actualización pasa
 * siempre `0` acá, y como esa hoja tampoco tiene la columna `etiqueta` el
 * salteo de `columnas` ya lo cubre — el parámetro solo importa para la
 * plantilla de alta.
 */
export function aplicarValidaciones(
  hoja,
  cantidadCategorias,
  columnas = COLUMNAS,
  ultimaFila = ULTIMA_FILA,
  cantidadEtiquetas = 0,
) {
  const posicion = (columna) => columnas.indexOf(columna) + 1;

  /** Aplica una validación solo si la columna existe en este layout. */
  const validar = (fila, columna, validacion) => {
    const indiceColumna = posicion(columna);
    if (indiceColumna === 0) return;
    hoja.getCell(fila, indiceColumna).dataValidation = validacion;
  };

  for (let fila = 2; fila <= ultimaFila; fila++) {
    // `whole` y no `decimal`: la columna `Product.costo` es `Decimal(10, 0)`,
    // así que un costo con centavos lo rechaza `normalizarCosto`
    // (`lib/importProductos.js`) recién al importar. Que Excel lo frene al
    // tipearlo le ahorra al admin descubrirlo con el archivo entero cargado.
    validar(fila, "costo", {
      type: "whole",
      operator: "greaterThan",
      formulae: [0],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: "Costo inválido",
      error: "El costo tiene que ser un número entero mayor a 0, sin decimales.",
    });

    // `decimal` acá SÍ, al revés que el costo: el coeficiente es el único campo
    // con decimales del sistema (`Decimal(5, 2)`). Excel no sabe acotar la
    // CANTIDAD de decimales, así que un 2,055 lo frena `normalizarCoeficiente`
    // al importar; lo que esta validación cubre es el rango.
    validar(fila, "coeficiente", {
      type: "decimal",
      operator: "between",
      formulae: [0.01, 999.99],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: "Coeficiente inválido",
      error:
        "El coeficiente multiplica al costo (2,05 = ×2,05). Tiene que estar entre 0,01 y 999,99. Vacío = 1.",
    });

    validar(fila, "stock", {
      type: "whole",
      operator: "greaterThanOrEqual",
      formulae: [0],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: "Stock inválido",
      error: "El stock tiene que ser un número entero mayor o igual a 0.",
    });

    // Estricto: `categoria` es una FK, un valor inventado no se puede importar.
    // Se omite si no hay categorías cargadas — un rango vacío rompe el archivo.
    if (cantidadCategorias > 0) {
      validar(fila, "categoria", {
        type: "list",
        allowBlank: true,
        formulae: [`${HOJA_LISTAS}!$A$2:$A$${cantidadCategorias + 1}`],
        showErrorMessage: true,
        errorTitle: "Categoría inválida",
        error: "Elegí una categoría de la lista o dejá la celda vacía.",
      });
    }

    // ESTRICTA desde que `Etiqueta` es una tabla. Era permisiva
    // (`showErrorMessage: false`) porque espejaba el `<datalist>` de texto
    // libre del formulario; hoy espeja un `<select>` de lista cerrada, y el
    // import rechaza un nombre que no exista. Se omite si no hay etiquetas
    // cargadas — un rango vacío rompe el archivo, mismo criterio que `categoria`.
    if (cantidadEtiquetas > 0) {
      validar(fila, "etiqueta", {
        type: "list",
        allowBlank: true,
        formulae: [`${HOJA_LISTAS}!$B$2:$B$${cantidadEtiquetas + 1}`],
        showErrorMessage: true,
        errorTitle: "Etiqueta inválida",
        error: "Elegí una etiqueta de la lista o dejá la celda vacía.",
      });
    }
  }
}
