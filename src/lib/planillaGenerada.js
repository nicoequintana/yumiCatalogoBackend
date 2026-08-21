import ExcelJS from "exceljs";
import { COLUMNAS, NOMBRE_HOJA } from "./importProductos.js";

/** El detalle público solo renderiza 3 beneficios (ver FichaProducto.jsx). */
const MAX_BENEFICIOS = 3;

const LISTAS = ["caracteristicas", "beneficios", "usos", "idealPara", "incluye"];

/**
 * Campos que deben ser array cuando están presentes. Superconjunto de LISTAS:
 * suma `especificaciones` (formato propio [{nombre,valor}], pero igual debe
 * ser un array) y los dos campos que solo viajan a la hoja Referencia
 * (`camposFaltantes`, `fotosSugeridas`). No se agregan directo a LISTAS
 * porque esa constante decide además qué columnas pasan por `unirLista` en
 * la hoja Productos, y `especificaciones` usa un formateador distinto
 * (`unirEspecificaciones`) mientras que `camposFaltantes`/`fotosSugeridas`
 * ni siquiera son columnas de esa hoja.
 */
const LISTAS_VALIDABLES = [...LISTAS, "especificaciones", "camposFaltantes", "fotosSugeridas"];

/**
 * Valida el JSON que produce la fase de redacción antes de escribir el Excel.
 *
 * Se valida acá y no en el importador porque un error detectado ahora cuesta
 * corregir un JSON; detectado en la importación, cuesta una vuelta completa.
 *
 * @param {object} [opciones]
 * @param {string[]} [opciones.categoriasVigentes] nombres de categorías de la
 *   base. Si se pasa, se rechaza cualquier categoría que no matchee (mismo
 *   criterio case-insensitive que el importador). Si no se pasa, la categoría
 *   no se valida (compatibilidad hacia atrás).
 * @returns {string[]} errores legibles; vacío si todo está bien
 */
export function validarRedacciones(redacciones, opciones = {}) {
  if (!Array.isArray(redacciones)) {
    throw new Error("El archivo de redacciones debe contener un array de productos.");
  }

  const { categoriasVigentes } = opciones;
  const vigentesNormalizadas = Array.isArray(categoriasVigentes)
    ? categoriasVigentes.map((nombre) => String(nombre).trim().toLowerCase())
    : null;

  const errores = [];

  redacciones.forEach((redaccion, indice) => {
    const fila = `Producto ${indice + 1}`;

    if (!String(redaccion?.nombre ?? "").trim()) errores.push(`${fila}: falta el nombre.`);
    if (!String(redaccion?.descripcion ?? "").trim()) errores.push(`${fila}: falta la descripción.`);

    for (const lista of LISTAS_VALIDABLES) {
      const valor = redaccion?.[lista];
      if (valor !== undefined && !Array.isArray(valor)) {
        errores.push(`${fila}: "${lista}" debe ser un array.`);
      }
    }

    if ((redaccion?.beneficios ?? []).length > MAX_BENEFICIOS) {
      errores.push(
        `${fila}: "beneficios" tiene ${redaccion.beneficios.length}; el catálogo solo muestra ${MAX_BENEFICIOS}.`,
      );
    }

    for (const especificacion of redaccion?.especificaciones ?? []) {
      if (!String(especificacion?.nombre ?? "").trim() || !String(especificacion?.valor ?? "").trim()) {
        errores.push(`${fila}: cada una de las "especificaciones" necesita nombre y valor.`);
        break;
      }
    }

    const categoria = redaccion?.categoria;
    if (vigentesNormalizadas && typeof categoria === "string" && categoria.trim() !== "") {
      if (!vigentesNormalizadas.includes(categoria.trim().toLowerCase())) {
        errores.push(`${fila}: la categoría "${categoria}" no existe en el panel.`);
      }
    }
  });

  return errores;
}

/** Las listas del importador se leen con un ítem por renglón (parsearLista). */
const unirLista = (items) => (items ?? []).map((item) => String(item).trim()).filter(Boolean).join("\n");

/** Las especificaciones se leen como "Nombre: Valor" por renglón. */
const unirEspecificaciones = (items) =>
  (items ?? []).map(({ nombre, valor }) => `${nombre}: ${valor}`).join("\n");

/**
 * Arma el workbook importable. El precio y el stock quedan VACÍOS a propósito:
 * son decisión comercial del dueño del catálogo, y como el importador exige
 * precio, la revisión humana queda forzada por el sistema en vez de sugerida.
 */
export async function construirPlanilla(redacciones) {
  const wb = new ExcelJS.Workbook();

  const hoja = wb.addWorksheet(NOMBRE_HOJA);
  hoja.addRow(COLUMNAS);
  hoja.columns = COLUMNAS.map((columna) => ({ width: columna.length + 14 }));

  for (const redaccion of redacciones) {
    hoja.addRow(
      COLUMNAS.map((columna) => {
        if (columna === "precio" || columna === "stock") return null;
        if (columna === "especificaciones") return unirEspecificaciones(redaccion.especificaciones);
        if (LISTAS.includes(columna)) return unirLista(redaccion[columna]);
        return redaccion[columna] ?? null;
      }),
    );
  }

  const referencia = wb.addWorksheet("Referencia");
  referencia.addRow(["nombre", "precioML", "camposFaltantes", "fotosSugeridas", "revisar", "url"]);
  referencia.columns = [{ width: 30 }, { width: 12 }, { width: 30 }, { width: 40 }, { width: 40 }, { width: 50 }];

  for (const redaccion of redacciones) {
    referencia.addRow([
      redaccion.nombre ?? "",
      redaccion.precioMLReferencia ?? "",
      unirLista(redaccion.camposFaltantes),
      unirLista(redaccion.fotosSugeridas),
      redaccion.revisar ?? "",
      redaccion.url ?? "",
    ]);
  }

  return wb;
}
