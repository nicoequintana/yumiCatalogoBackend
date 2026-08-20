import ExcelJS from "exceljs";
import { COLUMNAS, NOMBRE_HOJA } from "./importProductos.js";

/** El detalle público solo renderiza 3 beneficios (ver FichaProducto.jsx). */
const MAX_BENEFICIOS = 3;

const LISTAS = ["caracteristicas", "beneficios", "usos", "idealPara", "incluye"];

/**
 * Valida el JSON que produce la fase de redacción antes de escribir el Excel.
 *
 * Se valida acá y no en el importador porque un error detectado ahora cuesta
 * corregir un JSON; detectado en la importación, cuesta una vuelta completa.
 *
 * @returns {string[]} errores legibles; vacío si todo está bien
 */
export function validarRedacciones(redacciones) {
  if (!Array.isArray(redacciones)) {
    throw new Error("El archivo de redacciones debe contener un array de productos.");
  }

  const errores = [];

  redacciones.forEach((redaccion, indice) => {
    const fila = `Producto ${indice + 1}`;

    if (!String(redaccion?.nombre ?? "").trim()) errores.push(`${fila}: falta el nombre.`);
    if (!String(redaccion?.descripcion ?? "").trim()) errores.push(`${fila}: falta la descripción.`);

    for (const lista of LISTAS) {
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
  });

  return errores;
}
