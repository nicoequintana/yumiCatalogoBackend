/**
 * Parseo y validación de la entrada de los endpoints de producto.
 *
 * Todo lo de este módulo es sincrónico y puro: recibe lo que llega en el
 * request (multipart/form-data o JSON), lo normaliza y lanza `httpError(400)`
 * cuando no cumple. No toca la base ni el storage.
 */

import { httpError } from "../lib/httpError.js";
import { MAX_FOTOS, MAX_FOTO_BYTES } from "../lib/limitesMedios.js";
import { contenidoCoincideConMime } from "../lib/magicBytes.js";

export function parseCaracteristicas(raw) {
  if (raw === undefined) return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed.map((c) => ({ texto: String(c.texto ?? "").trim() })).filter((c) => c.texto !== "");
  } catch {
    throw httpError(400, "El campo caracteristicas debe ser un JSON válido (array de {texto}).");
  }
}

export function parseListas(raw, tipo) {
  if (raw === undefined) return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed
      .map((item) => ({ texto: String(item.texto ?? "").trim(), tipo }))
      .filter((item) => item.texto !== "");
  } catch {
    throw httpError(400, `El campo de lista (${tipo}) debe ser un JSON válido (array de {texto}).`);
  }
}

export function parseEspecificaciones(raw) {
  if (raw === undefined) return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed
      .map((item) => ({ nombre: String(item.nombre ?? "").trim(), valor: String(item.valor ?? "").trim() }))
      .filter((item) => item.nombre !== "" && item.valor !== "");
  } catch {
    throw httpError(400, "El campo especificaciones debe ser un JSON válido (array de {nombre, valor}).");
  }
}

export function parseFotosExistentes(raw) {
  if (raw === undefined) return undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed.map((id) => Number(id));
  } catch {
    throw httpError(400, "El campo fotosExistentes debe ser un JSON válido (array de ids).");
  }
}

/**
 * Parsea `ordenFotos`: la secuencia final completa de fotos que pide el
 * cliente, mezclando existentes y recién subidas.
 *
 *   [{ "tipo": "existente", "id": 12 }, { "tipo": "nueva", "index": 0 }, ...]
 *
 * Existe porque `fotosExistentes` sola no alcanza: solo dice QUÉ fotos
 * sobreviven, no en qué orden, y las nuevas siempre se agregaban al final.
 * Con eso era imposible reordenar fotos ya guardadas o subir una foto nueva
 * como portada — la posición 0 define la portada del catálogo y la 1 es la
 * imagen de "¿Qué problema resuelve?".
 *
 * Omitirlo mantiene el comportamiento histórico (existentes en el orden de la
 * base, nuevas al final), así que ningún cliente viejo se rompe.
 */
export function parsearOrdenFotos(raw) {
  if (raw === undefined || raw === "") return undefined;

  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) throw new Error();
  } catch {
    throw httpError(400, "El campo ordenFotos debe ser un JSON válido (array).");
  }

  return parsed.map((token) => {
    if (token?.tipo === "existente" && Number.isInteger(Number(token.id))) {
      return { tipo: "existente", id: Number(token.id) };
    }
    if (token?.tipo === "nueva" && Number.isInteger(Number(token.index))) {
      return { tipo: "nueva", index: Number(token.index) };
    }
    throw httpError(400, "ordenFotos tiene una entrada inválida: se espera {tipo, id} o {tipo, index}.");
  });
}

/**
 * La secuencia tiene que cubrir exactamente las fotos enviadas — ni de más ni
 * de menos, sin repetir. Un hueco o un duplicado dejaría `orden` inconsistente
 * y la portada quedaría a merced del desempate de la base.
 */
export function validarOrdenFotos(ordenFotos, { idsConservados, cantidadNuevas }) {
  if (ordenFotos === undefined) return;

  const existentes = ordenFotos.filter((t) => t.tipo === "existente").map((t) => t.id);
  const nuevas = ordenFotos.filter((t) => t.tipo === "nueva").map((t) => t.index);

  if (new Set(existentes).size !== existentes.length || new Set(nuevas).size !== nuevas.length) {
    throw httpError(400, "ordenFotos no puede repetir la misma foto.");
  }
  if (existentes.length !== idsConservados.length || existentes.some((id) => !idsConservados.includes(id))) {
    throw httpError(400, "ordenFotos debe listar exactamente las fotos existentes que se conservan.");
  }
  if (nuevas.length !== cantidadNuevas || nuevas.some((i) => i < 0 || i >= cantidadNuevas)) {
    throw httpError(400, "ordenFotos debe listar exactamente las fotos nuevas enviadas.");
  }
}

/**
 * Valida nombre y descripción.
 *
 * **`precio` ya NO entra acá.** Desde el 31/08/2026 el precio de venta no se
 * tipea en ninguna pantalla: sale de `costo × coeficiente`. El alta lo calcula y
 * lo escribe; la edición ni siquiera lo toca, para que cambiar un costo deje el
 * producto en `Difiere` hasta que alguien lo aplique desde Costos y precios.
 * Ver `validarCostoYCoeficiente`, que es donde vive ahora la validación de plata.
 */
export function validarCamposBase({ nombre, descripcion }, { esCreacion }) {
  if (esCreacion || nombre !== undefined) {
    if (typeof nombre !== "string" || nombre.trim() === "") {
      throw httpError(400, "El nombre del producto es obligatorio.");
    }
  }
  if (esCreacion || descripcion !== undefined) {
    if (typeof descripcion !== "string" || descripcion.trim() === "") {
      throw httpError(400, "La descripción del producto es obligatoria.");
    }
  }
}

/**
 * Coeficiente con el que entra un producto cuando nadie declara otro.
 *
 * **Es 1, el neutro: `costo × 1 = costo`.** Un producto sin margen elegido entra
 * valuado a lo que costó, que es el mínimo que no da pérdida — nunca a un precio
 * inventado por un default arbitrario.
 *
 * ⚠️ **El costo de esa elección: un producto recién cargado figura `AL_DIA` en la
 * pantalla de precios sin tener precio real**, porque el publicado coincide con
 * el calculado. Es correcto según la definición del estado y es engañoso igual.
 * Lo que delata a un producto pendiente es el coeficiente en 1, no el estado; de
 * ahí el chip "Sin precio real" de `AdminPrecios.jsx`.
 */
export const COEFICIENTE_POR_DEFECTO = "1";

/**
 * El coeficiente recibido, o el neutro si no vino ninguno.
 *
 * **Cubre las tres formas de "no vino": ausente, nulo y cadena vacía.** Las tres
 * llegan en la práctica —un `<input>` sin tocar manda `""`, una celda de Excel
 * en blanco manda `null`, un cliente viejo no manda el campo— y tratarlas
 * distinto haría que el alta funcione o falle según de dónde vino, que es
 * exactamente el tipo de diferencia que nadie relaciona con la causa.
 *
 * El COSTO no tiene equivalente y no debe tenerlo: es un dato del negocio que
 * nadie puede inventar, así que su ausencia es un 400 y no un default.
 */
export function coeficienteODefecto(valor) {
  if (valor === undefined || valor === null) return COEFICIENTE_POR_DEFECTO;
  if (typeof valor === "string" && valor.trim() === "") return COEFICIENTE_POR_DEFECTO;
  return valor;
}

/**
 * Valida y normaliza `costo` y `coeficiente` — los dos campos con los que el
 * admin calcula el precio de venta (ver `lib/precios.js`).
 *
 * Devuelve tres cosas distintas por campo, y no son intercambiables:
 *   `undefined` → no vino en el request, la columna no se toca
 *   `null`      → vino vacío, la columna se BORRA
 *   string      → valor normalizado, listo para Prisma
 *
 * La rama de `null` no es un detalle: sin ella, un costo cargado por error
 * quedaría pegado al producto para siempre.
 *
 * El `modo` restringe cuáles de esas tres formas se aceptan, y los tres son
 * distintos a propósito:
 *
 *   `"libre"` (default) → las tres. Lo usa `aplicarPreciosMasivo`, donde el
 *      coeficiente del lote es opcional: omitirlo significa "usá el de cada
 *      producto". Cablear ahí un requisito rompería ese endpoint sin que nada lo
 *      relacione con este cambio.
 *   `"alta"`   → el costo TIENE que venir con valor. Sin él no hay precio
 *      posible, y la columna `precio` es NOT NULL.
 *   `"edicion"` → omitir un campo está bien (el `PUT` es parcial: un request que
 *      solo reordena fotos no tiene por qué hablar de plata), pero VACIARLO no.
 *
 * Esa última distinción es la que hace usable la edición. Con el costo exigido
 * de forma incondicional, un `PUT` que solo cambia una foto fallaría por un
 * campo que no menciona — y un producto histórico sin costo cargado quedaría
 * imposible de editar hasta para corregirle una falta de ortografía. Lo que hay
 * que impedir es que alguien BORRE el costo de un producto, no que lo omita.
 *
 * El COEFICIENTE no se exige en ningún modo: tiene un neutro correcto y el
 * llamador lo aplica con `coeficienteODefecto`.
 */
export function validarCostoYCoeficiente({ costo, coeficiente }, { modo = "libre" } = {}) {
  // Se chequea ANTES de normalizar para distinguir "ausente" de "vacío": son la
  // misma cosa para el resto de la función, y acá son justamente lo que hay que
  // separar.
  const ausente = (valor) => valor === undefined;
  const vaciado = (valor) =>
    valor === null || (typeof valor === "string" && valor.trim() === "");

  if (modo === "alta" && (ausente(costo) || vaciado(costo))) {
    throw httpError(400, "El costo del producto es obligatorio.");
  }
  if (modo === "edicion") {
    if (vaciado(costo)) {
      throw httpError(400, "El costo del producto no se puede borrar.");
    }
    if (vaciado(coeficiente)) {
      throw httpError(400, "El coeficiente del producto no se puede borrar.");
    }
  }

  let costoNormalizado;
  if (costo !== undefined) {
    const crudo = typeof costo === "string" ? costo.trim() : costo;
    if (crudo === null || crudo === "") {
      costoNormalizado = null;
    } else {
      const numero = Number(crudo);
      if (!Number.isFinite(numero) || numero <= 0) {
        throw httpError(400, "El costo debe ser un número mayor a 0.");
      }
      // Mismo criterio que `precio` en `validarCamposBase`: la columna es
      // `Decimal(10, 0)`, así que un 1500.60 se guardaría como 1501 sin avisarle
      // a nadie — y el margen calculado a partir de él sería falso.
      if (!Number.isInteger(numero)) {
        throw httpError(400, "El costo debe ser un número entero, sin decimales.");
      }
      costoNormalizado = String(numero);
    }
  }

  let coeficienteNormalizado;
  if (coeficiente !== undefined) {
    const crudo = typeof coeficiente === "string" ? coeficiente.trim() : coeficiente;
    if (crudo === null || crudo === "") {
      coeficienteNormalizado = null;
    } else {
      // La coma se acepta como separador decimal, a diferencia del precio.
      // No es adivinar: "2,05" y "2.05" son el mismo número sin ninguna
      // ambigüedad, y acá el decimal es legítimo (es el único campo del sistema
      // que los lleva). En el precio lo que se rechaza es el decimal en sí, no
      // su notación — son dos reglas distintas y conviene no confundirlas.
      const texto = String(crudo).replace(",", ".");
      const numero = Number(texto);
      if (!Number.isFinite(numero) || numero <= 0) {
        throw httpError(400, "El coeficiente debe ser un número mayor a 0.");
      }
      // La columna es `Decimal(5, 2)`. Un tercer decimal se redondearía en
      // silencio y el precio que la pantalla muestra dejaría de coincidir con
      // el que el backend calcula al aplicar.
      const decimales = texto.split(".")[1]?.length ?? 0;
      if (decimales > 2) {
        throw httpError(400, "El coeficiente admite como máximo dos decimales.");
      }
      if (numero > 999.99) {
        throw httpError(400, "El coeficiente no puede ser mayor a 999,99.");
      }
      coeficienteNormalizado = String(numero);
    }
  }

  return { costo: costoNormalizado, coeficiente: coeficienteNormalizado };
}

/**
 * Coerces a `destacado` value that may arrive as a real boolean (JSON body)
 * or as a string (multipart/form-data, e.g. crear()/actualizar()) into a
 * strict boolean. Only the exact string forms "true"/"false" are accepted —
 * anything else (e.g. "1", "sí") is rejected rather than guessed at.
 */
function coerceDestacado(destacado) {
  if (typeof destacado === "boolean") return destacado;
  if (destacado === "true") return true;
  if (destacado === "false") return false;
  return undefined;
}

/**
 * Validates + normalizes the merchandising fields (`stock`, `destacado`).
 *
 * Tenía además un `orden` manual por producto, eliminado el 29/08/2026 junto
 * con su columna: no se usaba (los 80 productos de producción estaban todos en
 * 0) y no se va a usar.
 *
 * Follows the same `esCreacion` pattern as
 * `validarCamposBase`: a field is only validated/applied when the caller
 * explicitly sent it — omitting it on update leaves the existing value
 * untouched, and on create it just falls back to its DB default. Returns the
 * normalized values (booleans/numbers coerced from the raw strings
 * multipart/form-data sends) for the caller to use in the Prisma write.
 */
export function validarCamposMerchandising({ stock, destacado }) {
  let stockNormalizado;
  if (stock !== undefined) {
    if (stock === null || stock === "" || Number.isNaN(Number(stock)) || !Number.isInteger(Number(stock)) || Number(stock) < 0) {
      throw httpError(400, "stock debe ser un número entero mayor o igual a 0.");
    }
    stockNormalizado = Number(stock);
  }

  let destacadoNormalizado;
  if (destacado !== undefined) {
    destacadoNormalizado = coerceDestacado(destacado);
    if (destacadoNormalizado === undefined) {
      throw httpError(400, "destacado debe ser true o false.");
    }
  }

  return { stock: stockNormalizado, destacado: destacadoNormalizado };
}

/**
 * Normaliza y valida el `categoriaId` que llega en el body de alta/edición.
 *
 * - Ausente, `null`, o string vacío/espacios -> `null` ("sin categoría").
 * - Entero válido (string o número) -> el número.
 * - Cualquier otra cosa -> `httpError(400)`.
 *
 * Existe para que un valor no numérico no llegue a Prisma como `NaN` sobre una
 * columna `Int` (un `PrismaClientValidationError` -> 500 en `crear`/`actualizar`).
 * Espeja la guarda `Number.isInteger` que `construirFiltrosListado` ya aplica al
 * filtro `?categoria=` del listado público.
 *
 * NO decide entre "no tocar" (edición parcial) y "poner en null": eso lo resuelve
 * el llamador según si el campo vino en el request.
 *
 * @param {*} valor el `categoriaId` crudo del body
 * @returns {number|null}
 */
export function parsearCategoriaId(valor) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor === "string" && valor.trim() === "") return null;

  const id = Number(valor);
  if (!Number.isInteger(id)) {
    throw httpError(400, "La categoría seleccionada no es válida.");
  }
  return id;
}

export function validarArchivos({ fotosNuevas, fotosExistentesCount, video }) {
  if (fotosExistentesCount + fotosNuevas.length > MAX_FOTOS) {
    throw httpError(400, `Un producto admite un máximo de ${MAX_FOTOS} fotos.`);
  }
  for (const foto of fotosNuevas) {
    if (foto.size > MAX_FOTO_BYTES) {
      throw httpError(413, "Cada foto debe pesar como máximo 15MB.");
    }
    // Defensa en profundidad (content sniffing): multer ya filtró el `mimetype`
    // declarado, pero es falsificable. Se confirma que los BYTES reales sean los
    // de una imagen del tipo declarado antes de subir nada a Cloudinary.
    if (!contenidoCoincideConMime(foto.buffer, foto.mimetype)) {
      throw httpError(400, "El contenido de una de las imágenes no coincide con un archivo JPEG, PNG o WEBP válido.");
    }
  }
  if (video && video.length > 1) {
    throw httpError(400, "Un producto admite un único video.");
  }
  // Mismo chequeo de contenido para el video, si vino uno.
  if (video && video[0] && !contenidoCoincideConMime(video[0].buffer, video[0].mimetype)) {
    throw httpError(400, "El contenido del video no coincide con un archivo MP4 o WEBM válido.");
  }
}


/**
 * Tope de ids que puede nombrar una sola petición: el `?ids=` del listado y las
 * acciones masivas del panel. Es el mismo techo a propósito — "cuántas cosas
 * puede nombrar un cliente en un pedido" — y tenerlo dos veces sería tenerlo
 * distinto en cuanto alguien mueva uno.
 */
export const MAX_IDS_LISTADO = 100;

/**
 * Valida la lista de ids de una acción masiva del admin.
 *
 * Comparte `MAX_IDS_LISTADO` con `?ids=` del listado a propósito: es el mismo
 * techo de "cuántas cosas puede nombrar un cliente en un pedido", y tenerlo
 * dos veces sería tenerlo distinto en cuanto alguien mueva uno.
 *
 * Una lista vacía es un 400, no un no-op silencioso: si la pantalla mandó un
 * lote vacío hay un bug en la selección, y devolver `{ actualizados: 0 }`
 * lo escondería detrás de un cartel de éxito.
 */
export function parsearIdsMasivos(valor) {
  if (!Array.isArray(valor)) {
    throw httpError(400, "Se espera una lista de ids de producto.");
  }
  if (valor.length === 0) {
    throw httpError(400, "No se seleccionó ningún producto.");
  }
  if (valor.length > MAX_IDS_LISTADO) {
    throw httpError(400, `No se pueden procesar más de ${MAX_IDS_LISTADO} productos a la vez.`);
  }

  const ids = valor.map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw httpError(400, "La lista contiene ids de producto inválidos.");
  }

  return [...new Set(ids)];
}
