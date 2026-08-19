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

/** Devuelve el texto trimmeado de una celda, o `null` si está vacía. */
function textoOpcional(celda) {
  if (celda === null || celda === undefined) return null;
  const texto = String(celda).trim();
  return texto === "" ? null : texto;
}

/**
 * Normaliza el precio a string con punto decimal, que es lo que espera Prisma
 * para una columna `Decimal` (mismo formato que usa `crear` con `String(precio)`).
 *
 * ExcelJS devuelve un número real cuando la celda es numérica, pero un archivo
 * editado en otra herramienta puede traerlo como texto con coma decimal
 * ("1500,50") — se acepta y se normaliza en vez de rechazarlo.
 *
 * @returns {string|null} el precio normalizado, o `null` si no es válido
 */
function normalizarPrecio(celda) {
  if (celda === null || celda === undefined || celda === "") return null;

  const numero = typeof celda === "number" ? celda : Number(String(celda).trim().replace(",", "."));

  if (!Number.isFinite(numero) || numero <= 0) return null;

  return numero.toFixed(2).replace(/\.00$/, "");
}

/**
 * Valida una fila de la planilla y la mapea a los datos de un producto.
 *
 * Acumula TODOS los errores de la fila antes de devolver — no corta en el
 * primero, para que el admin vea todos los problemas de una sola pasada y
 * corrija la planilla en un solo viaje.
 *
 * @param {object} fila valores crudos de la fila, indexados por nombre de columna
 * @param {number} numeroFila número de fila TAL COMO SE VE EN EXCEL (encabezado = 1)
 * @param {Map<string, number>} categoriasPorNombre nombre en minúsculas -> id
 * @returns {{ datos: object|null, errores: Array<{fila:number,columna:string,valor:*,motivo:string}> }}
 */
export function validarFila(fila, numeroFila, categoriasPorNombre) {
  const errores = [];
  const error = (columna, valor, motivo) => errores.push({ fila: numeroFila, columna, valor, motivo });

  const nombre = textoOpcional(fila.nombre);
  if (nombre === null) error("nombre", fila.nombre ?? "", "El nombre es obligatorio.");

  const descripcion = textoOpcional(fila.descripcion);
  if (descripcion === null) error("descripcion", fila.descripcion ?? "", "La descripción es obligatoria.");

  const precio = normalizarPrecio(fila.precio);
  if (precio === null) {
    error("precio", fila.precio ?? "", "El precio debe ser un número mayor a 0.");
  }

  let stock = 0;
  if (fila.stock !== null && fila.stock !== undefined && fila.stock !== "") {
    const parseado = Number(fila.stock);
    if (!Number.isInteger(parseado) || parseado < 0) {
      error("stock", fila.stock, "El stock debe ser un número entero mayor o igual a 0.");
    } else {
      stock = parseado;
    }
  }

  let categoriaId = null;
  const categoria = textoOpcional(fila.categoria);
  if (categoria !== null) {
    const encontrada = categoriasPorNombre.get(categoria.toLowerCase());
    if (encontrada === undefined) {
      error("categoria", fila.categoria, "La categoría no existe.");
    } else {
      categoriaId = encontrada;
    }
  }

  let especificaciones = [];
  try {
    especificaciones = parsearEspecificaciones(fila.especificaciones);
  } catch (err) {
    error("especificaciones", fila.especificaciones, err.message);
  }

  if (errores.length > 0) return { datos: null, errores };

  return {
    datos: {
      nombre,
      descripcion,
      precio,
      stock,
      etiqueta: textoOpcional(fila.etiqueta),
      categoriaId,
      fraseComercial: textoOpcional(fila.fraseComercial),
      porQueLoVasAQuerer: textoOpcional(fila.porQueLoVasAQuerer),
      tePasaEsto: textoOpcional(fila.tePasaEsto),
      caracteristicas: parsearLista(fila.caracteristicas),
      beneficios: parsearLista(fila.beneficios),
      usos: parsearLista(fila.usos),
      idealPara: parsearLista(fila.idealPara),
      incluye: parsearLista(fila.incluye),
      especificaciones,
    },
    errores: [],
  };
}
