import ExcelJS from "exceljs";

/**
 * Marca de la fila de ejemplo que trae la plantilla. `leerArchivo` la
 * descarta: si el admin sube la plantilla sin tocarla (o se olvida de borrar
 * el ejemplo antes de cargar sus productos), ese producto de muestra NO tiene
 * que entrar al catálogo. Es texto visible a propósito — el admin ve por qué
 * esa fila es distinta.
 */
export const MARCA_EJEMPLO = "EJEMPLO (borrar esta fila)";

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

/**
 * Convierte una lista de ítems `{ texto }` de vuelta al texto multilínea que
 * `parsearLista` espera leer — es su inversa exacta, así el flujo de
 * exportación (`exportarProductos.js`) no tiene que reinventar el separador.
 *
 * Devuelve `null` (no `""`) para una lista vacía o ausente: una celda `null`
 * queda realmente en blanco en el `.xlsx`, en vez de una celda con texto
 * vacío que se ve distinto en Excel.
 */
export function serializarLista(items) {
  if (!items || items.length === 0) return null;
  return items.map((item) => item.texto).join("\n");
}

/**
 * Inversa exacta de `parsearEspecificaciones`: un renglón `"Nombre: Valor"`
 * por especificación.
 */
export function serializarEspecificaciones(especificaciones) {
  if (!especificaciones || especificaciones.length === 0) return null;
  return especificaciones.map((e) => `${e.nombre}: ${e.valor}`).join("\n");
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
 * Núcleo compartido de validación de fila: las reglas de campo (nombre,
 * descripción, precio, stock, categoría, especificaciones) que usan tanto el
 * alta (`validarFila`) como la actualización (`validarFilaActualizacion`).
 *
 * Privada a propósito — el `sku` NO es parte de este núcleo porque el alta ni
 * siquiera tiene esa columna. Acumula TODOS los errores de la fila antes de
 * devolver, no corta en el primero, para que el admin vea todos los
 * problemas de una sola pasada.
 *
 * @param {object} fila valores crudos de la fila, indexados por nombre de columna
 * @param {number} numeroFila número de fila TAL COMO SE VE EN EXCEL (encabezado = 1)
 * @param {Map<string, number>} categoriasPorNombre nombre en minúsculas -> id
 * @returns {{ datos: object|null, errores: Array<{fila:number,columna:string,valor:*,motivo:string}> }}
 */
function validarCamposDeProducto(fila, numeroFila, categoriasPorNombre) {
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

/**
 * Valida una fila de la planilla de ALTA y la mapea a los datos de un
 * producto nuevo. Ver `validarCamposDeProducto` para las reglas de campo.
 *
 * @param {object} fila valores crudos de la fila, indexados por nombre de columna
 * @param {number} numeroFila número de fila TAL COMO SE VE EN EXCEL (encabezado = 1)
 * @param {Map<string, number>} categoriasPorNombre nombre en minúsculas -> id
 * @returns {{ datos: object|null, errores: Array<{fila:number,columna:string,valor:*,motivo:string}> }}
 */
export function validarFila(fila, numeroFila, categoriasPorNombre) {
  return validarCamposDeProducto(fila, numeroFila, categoriasPorNombre);
}

/**
 * Valida una fila de la planilla de ACTUALIZACIÓN/ALTA MIXTA: las mismas
 * reglas de campo que `validarFila` MÁS la resolución del `sku` — que ahora
 * decide entre tres ramas, no solo dos:
 *
 * - `sku` vacío → fila de ALTA: `accion: "crear"`, `id: null`.
 * - `sku` presente y existe en `idsPorSku` → fila de ACTUALIZACIÓN:
 *   `accion: "actualizar"`, `id` resuelto.
 * - `sku` presente pero NO existe → error de fila, igual que antes. Esto es
 *   a propósito y no cambia: un SKU mal tipeado tiene que avisar, no crear
 *   un producto duplicado por accidente.
 *
 * El `sku` se valida por separado y sus errores se anteponen a los de campo,
 * mismo orden que su columna (primera de `COLUMNAS_ACTUALIZACION`).
 *
 * @param {object} fila valores crudos de la fila, indexados por nombre de columna
 * @param {number} numeroFila número de fila TAL COMO SE VE EN EXCEL (encabezado = 1)
 * @param {Map<string, number>} categoriasPorNombre nombre en minúsculas -> id
 * @param {Map<string, number>} idsPorSku sku -> id de producto existente
 * @returns {{ datos: object|null, id: number|null, accion: ("crear"|"actualizar"|null), errores: Array<{fila:number,columna:string,valor:*,motivo:string}> }}
 */
export function validarFilaActualizacion(fila, numeroFila, categoriasPorNombre, idsPorSku) {
  const erroresSku = [];
  const errorSku = (columna, valor, motivo) => erroresSku.push({ fila: numeroFila, columna, valor, motivo });

  const sku = textoOpcional(fila.sku);
  let id = null;
  let accion = null;
  if (sku === null) {
    accion = "crear";
  } else {
    const encontrado = idsPorSku.get(sku);
    if (encontrado === undefined) {
      errorSku("sku", fila.sku, "No existe ningún producto con este SKU.");
    } else {
      id = encontrado;
      accion = "actualizar";
    }
  }

  const { datos, errores } = validarCamposDeProducto(fila, numeroFila, categoriasPorNombre);
  const erroresTotales = [...erroresSku, ...errores];

  if (erroresTotales.length > 0) return { datos: null, id: null, accion: null, errores: erroresTotales };

  return { datos, id, accion, errores: [] };
}

/**
 * Columnas de la hoja `Productos`, en orden. Espejo del formulario de alta
 * (`AdminProductoForm.jsx`) salvo multimedia.
 *
 * `destacado` y `orden` NO están a propósito: no son parte del formulario, se
 * manejan por `PATCH /products/:id/merchandising`.
 *
 * Es la fuente de verdad compartida entre la generación de la plantilla
 * (`plantillaProductos.js`) y la lectura del archivo subido.
 */
export const COLUMNAS = [
  "nombre",
  "descripcion",
  "precio",
  "stock",
  "categoria",
  "etiqueta",
  "fraseComercial",
  "porQueLoVasAQuerer",
  "tePasaEsto",
  "caracteristicas",
  "beneficios",
  "usos",
  "idealPara",
  "incluye",
  "especificaciones",
];

/**
 * Columnas de la hoja de ACTUALIZACIÓN masiva: las mismas de `COLUMNAS` más
 * `sku` al frente, que es la clave de matcheo contra un producto existente.
 * Es lo que exporta `GET /products/export` y lo que vuelve a leer
 * `POST /products/actualizar-masivo`.
 */
export const COLUMNAS_ACTUALIZACION = ["sku", ...COLUMNAS];

export const NOMBRE_HOJA = "Productos";

/**
 * Tope de filas por archivo. El parseo y la transacción son en memoria en un
 * único contenedor: un archivo de decenas de miles de filas bloquearía el
 * proceso. 500 cubre holgadamente el caso real (cargar un catálogo).
 */
export const MAX_FILAS = 500;

/**
 * Tope de filas del flujo de ACTUALIZACIÓN masiva. Constante propia (no un
 * alias de `MAX_FILAS`) por si el día de mañana hace falta desacoplarla —
 * hoy comparte el mismo valor porque el catálogo exportado es, como mucho,
 * tan grande como el catálogo entero.
 */
export const MAX_FILAS_ACTUALIZACION = 500;

/** Extrae el valor plano de una celda de ExcelJS (desenvuelve fórmulas y rich text). */
function valorCelda(celda) {
  const valor = celda?.value;
  if (valor === null || valor === undefined) return null;
  if (typeof valor === "object") {
    if ("result" in valor) return valor.result ?? null;
    if ("richText" in valor) return valor.richText.map((t) => t.text).join("");
    if ("text" in valor) return valor.text;
  }
  return valor;
}

/**
 * Lee el `.xlsx` y devuelve una entrada por fila de datos, con el número de
 * fila tal como se ve en Excel (el encabezado es la fila 1) para que los
 * errores apunten a algo que el admin pueda ubicar en su planilla.
 *
 * Acumula a lo sumo `MAX_FILAS + 1` filas (o el tope correspondiente al array
 * `columnas` pasado, si se usa uno más grande): la de más alcanza para que el
 * caller detecte que el archivo supera el tope, sin cargar en memoria un
 * workbook arbitrariamente grande. El corte usa `MAX_FILAS` fijo a propósito
 * — es el mismo margen de seguridad para las dos hojas que hoy usa esta
 * función (alta y actualización comparten el mismo tope numérico).
 *
 * @param {Buffer} buffer
 * @param {string[]} [columnas] columnas a leer, en orden — default `COLUMNAS` (alta). La actualización pasa `COLUMNAS_ACTUALIZACION`.
 * @returns {Promise<Array<{numeroFila: number, valores: object}>>}
 */
export async function leerArchivo(buffer, columnas = COLUMNAS) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const hoja = wb.getWorksheet(NOMBRE_HOJA);
  if (!hoja) {
    throw new Error(
      `El archivo no tiene una hoja llamada "${NOMBRE_HOJA}". Descargá la plantilla y completala.`,
    );
  }

  const filas = [];

  hoja.eachRow((fila, numeroFila) => {
    if (numeroFila === 1) return; // encabezado

    // Corte temprano: apenas hay MAX_FILAS + 1 filas acumuladas ya se sabe que
    // el archivo se pasa del tope, así que no tiene sentido seguir cargando el
    // resto en memoria — un .xlsx muy comprimido puede traer decenas de miles
    // de filas. La fila de más queda a propósito: es lo que le permite al
    // caller (`procesarArchivo`/`procesarArchivoActualizacion`) detectar el
    // exceso y responder el mismo error de siempre.
    if (filas.length > MAX_FILAS) return;

    const valores = {};
    columnas.forEach((columna, indice) => {
      valores[columna] = valorCelda(fila.getCell(indice + 1));
    });

    const vacia = columnas.every(
      (columna) => valores[columna] === null || String(valores[columna]).trim() === "",
    );
    if (vacia) return;

    // Fila de ejemplo de la plantilla: se descarta aunque el admin la haya
    // dejado sin tocar (ver MARCA_EJEMPLO). Solo aplica a la hoja de alta —
    // la de actualización no tiene fila de ejemplo, pero `nombre` sigue
    // presente en sus columnas, así que el chequeo es inofensivo ahí.
    if (String(valores.nombre ?? "").startsWith(MARCA_EJEMPLO)) return;

    filas.push({ numeroFila, valores });
  });

  return filas;
}

/**
 * Pipeline completo: lee el archivo, valida el archivo como unidad (vacío,
 * límite de filas) y después valida cada fila acumulando errores.
 *
 * Un problema del ARCHIVO lanza (no tiene número de fila al que apuntar); un
 * problema de FILA se acumula en `errores`. Si hay al menos un error de fila,
 * `productos` viene vacío: el caller no debe escribir nada (todo o nada).
 *
 * @param {Buffer} buffer
 * @param {Map<string, number>} categoriasPorNombre nombre en minúsculas -> id
 */
export async function procesarArchivo(buffer, categoriasPorNombre) {
  const filas = await leerArchivo(buffer);

  if (filas.length === 0) {
    throw new Error("El archivo no tiene ninguna fila para importar.");
  }
  if (filas.length > MAX_FILAS) {
    throw new Error(`El archivo tiene más de ${MAX_FILAS} filas. Dividilo en varios archivos.`);
  }

  const productos = [];
  const errores = [];

  for (const { numeroFila, valores } of filas) {
    const resultado = validarFila(valores, numeroFila, categoriasPorNombre);
    if (resultado.errores.length > 0) errores.push(...resultado.errores);
    else productos.push(resultado.datos);
  }

  return errores.length > 0 ? { productos: [], errores } : { productos, errores: [] };
}

/**
 * Pipeline completo de la ACTUALIZACIÓN/ALTA masiva: mismo espíritu que
 * `procesarArchivo`, pero lee `COLUMNAS_ACTUALIZACION` y por cada fila decide
 * entre crear (sku vacío) o actualizar (sku existente) — ver
 * `validarFilaActualizacion`. Es lo que permite reusar el mismo `.xlsx`
 * exportado tanto para editar productos existentes como para agregar filas
 * nuevas al final, sin pasar por la pantalla de alta clásica.
 *
 * Todo o nada, igual que el alta: si hay al menos un error de fila,
 * `operaciones` viene vacío.
 *
 * @param {Buffer} buffer
 * @param {Map<string, number>} categoriasPorNombre nombre en minúsculas -> id
 * @param {Map<string, number>} idsPorSku sku -> id de producto existente
 * @returns {Promise<{ operaciones: Array<{accion:("crear"|"actualizar"), id:number|null, datos:object}>, errores: Array }>}
 */
export async function procesarArchivoActualizacion(buffer, categoriasPorNombre, idsPorSku) {
  const filas = await leerArchivo(buffer, COLUMNAS_ACTUALIZACION);

  if (filas.length === 0) {
    throw new Error("El archivo no tiene ninguna fila para actualizar o crear.");
  }
  if (filas.length > MAX_FILAS_ACTUALIZACION) {
    throw new Error(`El archivo tiene más de ${MAX_FILAS_ACTUALIZACION} filas. Dividilo en varios archivos.`);
  }

  const operaciones = [];
  const errores = [];

  for (const { numeroFila, valores } of filas) {
    const resultado = validarFilaActualizacion(valores, numeroFila, categoriasPorNombre, idsPorSku);
    if (resultado.errores.length > 0) errores.push(...resultado.errores);
    else operaciones.push({ accion: resultado.accion, id: resultado.id, datos: resultado.datos });
  }

  return errores.length > 0 ? { operaciones: [], errores } : { operaciones, errores: [] };
}
