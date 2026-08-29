/**
 * Parseo y validación de la entrada de los endpoints de producto.
 *
 * Todo lo de este módulo es sincrónico y puro: recibe lo que llega en el
 * request (multipart/form-data o JSON), lo normaliza y lanza `httpError(400)`
 * cuando no cumple. No toca la base ni el storage.
 */

import { httpError } from "../lib/httpError.js";
import { MAX_FOTOS, MAX_FOTO_BYTES } from "../lib/limitesMedios.js";

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

export function validarCamposBase({ nombre, descripcion, precio }, { esCreacion }) {
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
  if (esCreacion || precio !== undefined) {
    // Mismo criterio que `normalizarPrecio` en `lib/importProductos.js`:
    // entero, finito y mayor a 0. El chequeo viejo (`!Number.isNaN`) dejaba
    // entrar precios negativos a la base (y de ahí a los snapshots de
    // `ItemOrden` de futuras órdenes) y aceptaba `"Infinity"`, que no es NaN
    // pero revienta contra el `Decimal` de Prisma con un 500.
    //
    // El decimal se RECHAZA, no se redondea. La columna es `Decimal(10, 0)`:
    // si esto dejara pasar `1500.60`, SQL Server lo guardaría como `1501`
    // sin avisarle a nadie, y el admin vería en el listado un precio que no
    // es el que cargó. Un 400 que nombra el problema es mejor que una
    // corrección silenciosa de la plata.
    const numero = Number(precio);
    if (precio === undefined || precio === null || precio === "" || !Number.isFinite(numero) || numero <= 0) {
      throw httpError(400, "El precio del producto debe ser un número mayor a 0.");
    }
    if (!Number.isInteger(numero)) {
      throw httpError(400, "El precio del producto debe ser un número entero, sin decimales.");
    }
  }
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

export function validarArchivos({ fotosNuevas, fotosExistentesCount, video }) {
  if (fotosExistentesCount + fotosNuevas.length > MAX_FOTOS) {
    throw httpError(400, `Un producto admite un máximo de ${MAX_FOTOS} fotos.`);
  }
  for (const foto of fotosNuevas) {
    if (foto.size > MAX_FOTO_BYTES) {
      throw httpError(413, "Cada foto debe pesar como máximo 15MB.");
    }
  }
  if (video && video.length > 1) {
    throw httpError(400, "Un producto admite un único video.");
  }
}
