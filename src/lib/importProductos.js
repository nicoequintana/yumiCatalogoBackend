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

/** Devuelve el texto trimmeado de una celda, o `null` si está vacía. */
function textoOpcional(celda) {
  if (celda === null || celda === undefined) return null;
  const texto = String(celda).trim();
  return texto === "" ? null : texto;
}

/**
 * Normaliza el costo a string entero, que es lo que espera Prisma para la
 * columna `Decimal(10, 0)`.
 *
 * Reemplazó a `normalizarPrecio` el 31/08/2026, cuando el precio de venta pasó
 * a derivarse de `costo × coeficiente` y dejó de viajar en la planilla. La regla
 * es la misma de antes, aplicada al campo que ahora recibe ese número.
 *
 * ExcelJS devuelve un número real cuando la celda es numérica, pero un archivo
 * editado en otra herramienta puede traerlo como texto con coma decimal
 * ("1500,50") — la coma se sigue interpretando como separador decimal para
 * poder DETECTARLA, no para aceptarla.
 *
 * Un costo con decimales se RECHAZA (mismo criterio que `validarCostoYCoeficiente`
 * en `controllers/products.input.js`): la columna es entera, así que redondear
 * acá le cambiaría el costo a un producto sin que la planilla ni el informe lo
 * mencionen — y de ese número redondeado saldría después un precio de venta que
 * nadie pidió. Un error de fila que nombra el problema es lo único que le da al
 * admin la chance de corregir el archivo.
 *
 * @returns {string|null} el costo normalizado, o `null` si no es válido
 */
function normalizarCosto(celda) {
  if (celda === null || celda === undefined || celda === "") return null;

  const numero = typeof celda === "number" ? celda : Number(String(celda).trim().replace(",", "."));

  if (!Number.isFinite(numero) || numero <= 0 || !Number.isInteger(numero)) return null;

  return String(numero);
}

/**
 * Coeficiente por defecto de la planilla. **Espejo manual de
 * `COEFICIENTE_POR_DEFECTO` en `controllers/products.input.js`** — este módulo
 * es `lib/` y no importa de `controllers/`, que es la dirección de dependencia
 * que el proyecto ya respeta.
 *
 * Si divergen, un producto cargado por planilla entra con un margen distinto que
 * el mismo producto cargado por formulario, sin ningún error.
 */
const COEFICIENTE_PLANILLA_POR_DEFECTO = "1";

/**
 * Normaliza el coeficiente a string, con las reglas de su columna `Decimal(5, 2)`.
 *
 * **Es el único campo con decimales del sistema**, así que sus reglas son las
 * opuestas a las del costo: acá el decimal es legítimo y lo que se acota es
 * cuántos hay. La coma se acepta como separador — "2,05" y "2.05" son el mismo
 * número sin ninguna ambigüedad.
 *
 * Una celda vacía cae al neutro y NO es un error, a diferencia del costo: el
 * costo es un dato del negocio que nadie puede inventar, el coeficiente tiene un
 * valor correcto por defecto (1, que deja el precio igual al costo).
 *
 * @returns {string|null} el coeficiente normalizado, o `null` si no es válido
 */
function normalizarCoeficiente(celda) {
  if (celda === null || celda === undefined || celda === "") {
    return COEFICIENTE_PLANILLA_POR_DEFECTO;
  }

  const texto = String(celda).trim().replace(",", ".");
  const numero = Number(texto);

  if (!Number.isFinite(numero) || numero <= 0 || numero > 999.99) return null;
  // Un tercer decimal se redondearía en silencio contra `Decimal(5, 2)` y el
  // precio calculado dejaría de coincidir con el que muestra el panel.
  if ((texto.split(".")[1]?.length ?? 0) > 2) return null;

  return String(numero);
}

/**
 * Núcleo compartido de validación de fila: las reglas de campo (nombre,
 * descripción, costo, coeficiente, stock, categoría, especificaciones) que usan
 * tanto el alta (`validarFila`) como la actualización (`validarFilaActualizacion`).
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

  const costo = normalizarCosto(fila.costo);
  if (costo === null) {
    error("costo", fila.costo ?? "", "El costo debe ser un número entero mayor a 0, sin decimales.");
  }

  const coeficiente = normalizarCoeficiente(fila.coeficiente);
  if (coeficiente === null) {
    error(
      "coeficiente",
      fila.coeficiente ?? "",
      "El coeficiente debe ser un número mayor a 0 y hasta 999,99, con dos decimales como máximo.",
    );
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
      costo,
      coeficiente,
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
 * Reglas de campo de una fila de ACTUALIZACIÓN: `nombre`, `precio` y `stock`.
 *
 * Es un núcleo aparte de `validarCamposDeProducto` (el del alta) y no una
 * variante suya con banderas, porque no comparten el contrato: el alta valida
 * quince campos y **exige** descripción; la actualización valida tres y no
 * conoce los otros doce. Meter las dos reglas en una función con condicionales
 * es lo que hace que un día alguien afloje una validación del alta creyendo
 * que ajusta la de actualización.
 *
 * A diferencia del alta, `stock` es **obligatorio**: una celda vacía en el
 * alta significa "arranca en 0", pero acá significaría "poné en 0 el stock
 * de un producto que ya tenía existencias", que casi nunca es lo que quiso
 * quien dejó la celda sin tocar. Se pide explícito.
 *
 * Acumula TODOS los errores de la fila antes de devolver, mismo criterio que
 * el alta: el admin ve todos los problemas de una sola pasada.
 *
 * @param {object} fila valores crudos de la fila, indexados por nombre de columna
 * @param {number} numeroFila número de fila TAL COMO SE VE EN EXCEL (encabezado = 1)
 * @returns {{ datos: object|null, errores: Array<{fila:number,columna:string,valor:*,motivo:string}> }}
 */
function validarCamposDeActualizacion(fila, numeroFila) {
  const errores = [];
  const error = (columna, valor, motivo) => errores.push({ fila: numeroFila, columna, valor, motivo });

  const nombre = textoOpcional(fila.nombre);
  if (nombre === null) error("nombre", fila.nombre ?? "", "El nombre es obligatorio.");

  const costo = normalizarCosto(fila.costo);
  if (costo === null) {
    error("costo", fila.costo ?? "", "El costo debe ser un número entero mayor a 0, sin decimales.");
  }

  const coeficiente = normalizarCoeficiente(fila.coeficiente);
  if (coeficiente === null) {
    error(
      "coeficiente",
      fila.coeficiente ?? "",
      "El coeficiente debe ser un número mayor a 0 y hasta 999,99, con dos decimales como máximo.",
    );
  }

  let stock = null;
  if (fila.stock === null || fila.stock === undefined || fila.stock === "") {
    error("stock", fila.stock ?? "", "El stock es obligatorio.");
  } else {
    const parseado = Number(fila.stock);
    if (!Number.isInteger(parseado) || parseado < 0) {
      error("stock", fila.stock, "El stock debe ser un número entero mayor o igual a 0.");
    } else {
      stock = parseado;
    }
  }

  if (errores.length > 0) return { datos: null, errores };

  return { datos: { nombre, costo, coeficiente, stock }, errores: [] };
}

/**
 * Valida una fila de la planilla de ACTUALIZACIÓN y resuelve su `sku` contra
 * un producto existente. Dos ramas, no tres:
 *
 * - `sku` presente y existe en `idsPorSku` → `id` resuelto.
 * - `sku` vacío o inexistente → error de fila.
 *
 * **La rama de ALTA por `sku` vacío se eliminó el 25/08/2026**, junto con el
 * recorte de `COLUMNAS_ACTUALIZACION` a cuatro columnas. No fue una decisión
 * de gusto: `Product.descripcion` es `NOT NULL` y la planilla ya no trae esa
 * columna, así que un producto nuevo creado desde este archivo no puede
 * existir. Las altas van por `POST /products/import` (pantalla
 * `/catalogo/admin/productos/importar`), que sigue usando la plantilla
 * completa de quince campos.
 *
 * Que un `sku` inexistente sea error tampoco cambia, y es la misma protección
 * de siempre: un SKU mal tipeado tiene que avisar, no crear un duplicado.
 *
 * El `sku` se valida por separado y sus errores se anteponen a los de campo,
 * mismo orden que su columna (primera de `COLUMNAS_ACTUALIZACION`).
 *
 * @param {object} fila valores crudos de la fila, indexados por nombre de columna
 * @param {number} numeroFila número de fila TAL COMO SE VE EN EXCEL (encabezado = 1)
 * @param {Map<string, number>} idsPorSku sku -> id de producto existente
 * @returns {{ datos: object|null, id: number|null, errores: Array<{fila:number,columna:string,valor:*,motivo:string}> }}
 */
export function validarFilaActualizacion(fila, numeroFila, idsPorSku) {
  const erroresSku = [];
  const errorSku = (columna, valor, motivo) => erroresSku.push({ fila: numeroFila, columna, valor, motivo });

  const sku = textoOpcional(fila.sku);
  let id = null;
  if (sku === null) {
    errorSku("sku", fila.sku ?? "", "El SKU es obligatorio. Este archivo solo actualiza productos que ya existen.");
  } else {
    const encontrado = idsPorSku.get(sku);
    if (encontrado === undefined) {
      errorSku("sku", fila.sku, "No existe ningún producto con este SKU.");
    } else {
      id = encontrado;
    }
  }

  const { datos, errores } = validarCamposDeActualizacion(fila, numeroFila);
  const erroresTotales = [...erroresSku, ...errores];

  if (erroresTotales.length > 0) return { datos: null, id: null, errores: erroresTotales };

  return { datos, id, errores: [] };
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
  "costo",
  "coeficiente",
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
 * Columnas de la hoja de ACTUALIZACIÓN masiva. Es lo que exporta
 * `GET /products/export` y lo que vuelve a leer
 * `POST /products/actualizar-masivo`.
 *
 * **Es un subconjunto chico y deliberado de `COLUMNAS`, NO `["sku", ...COLUMNAS]`
 * como era hasta el 25/08/2026.** El flujo existe para retocar precios y stock
 * de un catálogo ya cargado, y para eso la planilla completa de 16 columnas
 * era más estorbo que ayuda: hay que scrollear entre textos largos para
 * llegar al número que se quiere cambiar.
 *
 * La consecuencia importante NO es cosmética: al no viajar en el archivo,
 * descripción, categoría, etiqueta, contenido comercial, listas y
 * especificaciones **quedan intactas** en la actualización. Antes viajaban
 * todas y se reescribían enteras en cada subida. Ver `dataDeActualizacion` en
 * `controllers/productsImport.controller.js`, que es donde esa garantía se
 * cumple o se rompe.
 */
export const COLUMNAS_ACTUALIZACION = ["sku", "nombre", "costo", "coeficiente", "stock"];

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
 * Pipeline completo de la ACTUALIZACIÓN masiva: mismo espíritu que
 * `procesarArchivo`, pero lee `COLUMNAS_ACTUALIZACION` (cuatro columnas) y
 * resuelve cada fila contra un producto existente por `sku` — ver
 * `validarFilaActualizacion`.
 *
 * Ya no crea productos: la rama de alta por `sku` vacío se eliminó el
 * 25/08/2026 porque la planilla dejó de traer `descripcion`, que es `NOT NULL`.
 *
 * Todo o nada, igual que el alta: si hay al menos un error de fila,
 * `operaciones` viene vacío.
 *
 * @param {Buffer} buffer
 * @param {Map<string, number>} idsPorSku sku -> id de producto existente
 * @returns {Promise<{ operaciones: Array<{id:number, datos:object}>, errores: Array }>}
 */
export async function procesarArchivoActualizacion(buffer, idsPorSku) {
  const filas = await leerArchivo(buffer, COLUMNAS_ACTUALIZACION);

  if (filas.length === 0) {
    throw new Error("El archivo no tiene ninguna fila para actualizar.");
  }
  if (filas.length > MAX_FILAS_ACTUALIZACION) {
    throw new Error(`El archivo tiene más de ${MAX_FILAS_ACTUALIZACION} filas. Dividilo en varios archivos.`);
  }

  const operaciones = [];
  const errores = [];

  for (const { numeroFila, valores } of filas) {
    const resultado = validarFilaActualizacion(valores, numeroFila, idsPorSku);
    if (resultado.errores.length > 0) errores.push(...resultado.errores);
    else operaciones.push({ id: resultado.id, datos: resultado.datos });
  }

  return errores.length > 0 ? { operaciones: [], errores } : { operaciones, errores: [] };
}
