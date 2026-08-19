import ExcelJS from "exceljs";
import { COLUMNAS, MAX_FILAS, NOMBRE_HOJA } from "./importProductos.js";

/**
 * Mismas sugerencias que el `<datalist>` del formulario de alta
 * (`AdminProductoForm.jsx`, `SUGERENCIAS_ETIQUETA`). Duplicación consciente:
 * el backend no puede importar del frontend. Si cambian allá, cambiar acá.
 */
export const ETIQUETAS_SUGERIDAS = ["Exclusivo", "Nuevo", "Best Seller", "Trending", "Popular"];

const HOJA_LISTAS = "Listas";

/** Última fila a la que se aplican las validaciones (el admin puede llenar hasta MAX_FILAS). */
const ULTIMA_FILA = MAX_FILAS + 1;

const FILA_EJEMPLO = {
  nombre: "Vela de soja lavanda",
  descripcion: "Vela artesanal de cera de soja con aroma a lavanda.",
  precio: 1500,
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
 * @returns {Promise<Buffer>}
 */
export async function generarPlantilla(categorias) {
  const wb = new ExcelJS.Workbook();

  const listas = wb.addWorksheet(HOJA_LISTAS);
  listas.getCell("A1").value = "Categorías";
  listas.getCell("B1").value = "Etiquetas sugeridas";
  categorias.forEach((nombre, indice) => {
    listas.getCell(`A${indice + 2}`).value = nombre;
  });
  ETIQUETAS_SUGERIDAS.forEach((etiqueta, indice) => {
    listas.getCell(`B${indice + 2}`).value = etiqueta;
  });

  const hoja = wb.addWorksheet(NOMBRE_HOJA);
  hoja.addRow(COLUMNAS);
  hoja.getRow(1).font = { bold: true };
  hoja.columns = COLUMNAS.map((columna) => ({ width: columna.length + 14 }));
  hoja.addRow(COLUMNAS.map((columna) => FILA_EJEMPLO[columna] ?? null));

  aplicarValidaciones(hoja, categorias.length);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Aplica las validaciones de Excel a todo el rango editable de cada columna. */
function aplicarValidaciones(hoja, cantidadCategorias) {
  const indice = (columna) => COLUMNAS.indexOf(columna) + 1;

  for (let fila = 2; fila <= ULTIMA_FILA; fila++) {
    hoja.getCell(fila, indice("precio")).dataValidation = {
      type: "decimal",
      operator: "greaterThan",
      formulae: [0],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: "Precio inválido",
      error: "El precio tiene que ser un número mayor a 0.",
    };

    hoja.getCell(fila, indice("stock")).dataValidation = {
      type: "whole",
      operator: "greaterThanOrEqual",
      formulae: [0],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: "Stock inválido",
      error: "El stock tiene que ser un número entero mayor o igual a 0.",
    };

    // Estricto: `categoria` es una FK, un valor inventado no se puede importar.
    // Se omite si no hay categorías cargadas — un rango vacío rompe el archivo.
    if (cantidadCategorias > 0) {
      hoja.getCell(fila, indice("categoria")).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`${HOJA_LISTAS}!$A$2:$A$${cantidadCategorias + 1}`],
        showErrorMessage: true,
        errorTitle: "Categoría inválida",
        error: "Elegí una categoría de la lista o dejá la celda vacía.",
      };
    }

    // Permisivo: en el formulario `etiqueta` es texto libre con sugerencias
    // (un `<datalist>`), no un enum. El desplegable sugiere pero no bloquea.
    hoja.getCell(fila, indice("etiqueta")).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`${HOJA_LISTAS}!$B$2:$B$${ETIQUETAS_SUGERIDAS.length + 1}`],
      showErrorMessage: false,
    };
  }
}
