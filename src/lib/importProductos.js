/**
 * Lógica pura de la importación masiva de productos desde `.xlsx`.
 *
 * No importa Prisma ni Express a propósito: recibe los datos ya leídos y
 * devuelve estructuras planas, así se puede testear cada regla sin base ni
 * servidor. El controller es el que orquesta lectura, transacción y auditoría.
 */

/**
 * Convierte el texto multilínea de una celda en una lista de ítems.
 *
 * El separador es el salto de línea (`Alt+Enter` en Excel), NO el punto y
 * coma: un ";" es texto legítimo dentro de un beneficio ("Recargable; también
 * funciona con pilas") y partir por él rompería el ítem en dos sin aviso.
 */
export function parsearLista(celda) {
  if (celda === null || celda === undefined) return [];

  return String(celda)
    .split(/\r?\n/)
    .map((linea) => linea.trim())
    .filter((linea) => linea !== "")
    .map((texto) => ({ texto }));
}

/**
 * Convierte el texto multilínea de la celda de especificaciones en pares
 * nombre/valor. Un renglón por especificación, con formato `Nombre: Valor`.
 *
 * Parte en el PRIMER ":" y no en todos, para que el valor pueda contener ":"
 * (ej. "Horario: 9:00 a 18:00").
 *
 * Lanza `Error` ante un renglón mal formado — el caller lo convierte en un
 * error de fila con su número y columna.
 */
export function parsearEspecificaciones(celda) {
  if (celda === null || celda === undefined) return [];

  return String(celda)
    .split(/\r?\n/)
    .map((linea) => linea.trim())
    .filter((linea) => linea !== "")
    .map((linea) => {
      const corte = linea.indexOf(":");
      const nombre = corte === -1 ? "" : linea.slice(0, corte).trim();
      const valor = corte === -1 ? "" : linea.slice(corte + 1).trim();

      if (nombre === "" || valor === "") {
        throw new Error(
          `Cada especificación debe tener el formato "Nombre: Valor". Renglón inválido: "${linea}".`,
        );
      }

      return { nombre, valor };
    });
}
