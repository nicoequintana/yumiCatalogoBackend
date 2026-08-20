import { prisma } from "../lib/prisma.js";
import * as googleDrive from "../services/googleDrive.service.js";
import * as cloudinary from "../services/cloudinary.service.js";
import { generarSku } from "../lib/sku.js";
import { procesarArchivo } from "../lib/importProductos.js";
import { generarPlantilla } from "../lib/plantillaProductos.js";
import { logError } from "../lib/logError.js";
import { logAudit } from "../lib/logAudit.js";
import { logEvento, headersDeEvento } from "../lib/logEvento.js";

const MAX_FOTOS = 10;
const MAX_FOTO_BYTES = 15 * 1024 * 1024; // 15MB per-field cap (design: multer's global limit can't differ per field)

const PRODUCT_INCLUDE = {
  caracteristicas: true,
  fotos: { orderBy: { orden: "asc" } },
  video: true,
  categoria: true,
  listas: { orderBy: { orden: "asc" } },
  especificaciones: { orderBy: { orden: "asc" } },
};

/**
 * Maps a Prisma Product row (with relations) to the API response shape.
 *
 * Photo URLs (post-archive bugfix, see topic
 * "sdd/backend-drive-sqlserver/photo-proxy-postfix"): a raw
 * `drive.google.com/uc?export=view` URL triggers `net::ERR_BLOCKED_BY_ORB`
 * in real Chromium — Drive's redirect chain has an ambiguous Content-Type
 * on the initial 303 hop, which browsers now block for `<img>` requests.
 * `curl`/Node HTTP checks don't reproduce this because ORB is a browser-only
 * mitigation. Real uploaded photos (driveFileId set) are therefore routed
 * through the backend proxy (`streamFoto`, mirrors the existing video
 * proxy). Seed/placeholder photos (driveFileId null) keep their original
 * `placehold.co` URL untouched — there is nothing to proxy and no ORB risk
 * for that host.
 */
function agruparListasPorTipo(listas) {
  const porTipo = { BENEFICIO: [], USO: [], IDEAL_PARA: [], INCLUYE: [] };
  for (const item of listas) {
    porTipo[item.tipo]?.push({ id: item.id, texto: item.texto });
  }
  return porTipo;
}

function mapProducto(producto) {
  return {
    id: producto.id,
    sku: producto.sku,
    nombre: producto.nombre,
    descripcion: producto.descripcion,
    precio: producto.precio.toString(),
    etiqueta: producto.etiqueta,
    categoria: producto.categoria ? { id: producto.categoria.id, nombre: producto.categoria.nombre } : null,
    vistas: producto.vistas,
    compartidos: producto.compartidos,
    favoritosCount: producto.favoritosCount,
    visibleEnCatalogo: producto.visibleEnCatalogo,
    stock: producto.stock,
    destacado: producto.destacado,
    orden: producto.orden,
    caracteristicas: producto.caracteristicas.map((c) => ({ id: c.id, texto: c.texto })),
    fraseComercial: producto.fraseComercial,
    porQueLoVasAQuerer: producto.porQueLoVasAQuerer,
    tePasaEsto: producto.tePasaEsto,
    beneficios: agruparListasPorTipo(producto.listas ?? []).BENEFICIO,
    usos: agruparListasPorTipo(producto.listas ?? []).USO,
    idealPara: agruparListasPorTipo(producto.listas ?? []).IDEAL_PARA,
    incluye: agruparListasPorTipo(producto.listas ?? []).INCLUYE,
    especificaciones: (producto.especificaciones ?? []).map((e) => ({ id: e.id, nombre: e.nombre, valor: e.valor })),
    // `driveFileId` NO se expone: la URL de arriba ya resuelve el storage del
    // lado del servidor (Cloudinary directo, o el proxy propio para las filas
    // legado de Drive), así que mandarlo solo filtraría un identificador
    // interno de storage en un endpoint público. Ningún cliente lo lee.
    fotos: producto.fotos.map((f) => ({
      id: f.id,
      url: f.cloudinaryPublicId ? f.url : f.driveFileId ? `/api/products/${producto.id}/fotos/${f.id}` : f.url,
      orden: f.orden,
    })),
    video: producto.video
      ? {
          id: producto.video.id,
          url: producto.video.cloudinaryPublicId
            ? producto.video.url
            : `/api/products/${producto.id}/video`,
        }
      : null,
    createdAt: producto.createdAt,
    updatedAt: producto.updatedAt,
  };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Sanitizes a free-text product name for use as a Cloudinary folder path
 * segment. Cloudinary's `folder` param treats `/` as a path separator, so an
 * unsanitized name containing `/` (e.g. "Anillo/Oro 18k") would silently
 * create nested subfolders instead of one flat per-product folder. Replaces
 * `/` and other path-meaningful characters with `-`.
 *
 * @param {string} nombre
 * @returns {string}
 */
function sanitizarNombreParaCarpeta(nombre) {
  return nombre.replace(/[/\\?%*:|"<>]/g, "-");
}

function parseCaracteristicas(raw) {
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

function parseFotosExistentes(raw) {
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
function parsearOrdenFotos(raw) {
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
function validarOrdenFotos(ordenFotos, { idsConservados, cantidadNuevas }) {
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

function validarCamposBase({ nombre, descripcion, precio }, { esCreacion }) {
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
    if (precio === undefined || precio === null || precio === "" || Number.isNaN(Number(precio))) {
      throw httpError(400, "El precio del producto debe ser un número válido.");
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
 * Validates + normalizes the merchandising fields added in Sprint 3
 * (`stock`, `destacado`, `orden`). Follows the same `esCreacion` pattern as
 * `validarCamposBase`: a field is only validated/applied when the caller
 * explicitly sent it — omitting it on update leaves the existing value
 * untouched, and on create it just falls back to its DB default. Returns the
 * normalized values (booleans/numbers coerced from the raw strings
 * multipart/form-data sends) for the caller to use in the Prisma write.
 */
function validarCamposMerchandising({ stock, destacado, orden }) {
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

  let ordenNormalizado;
  if (orden !== undefined) {
    if (orden === null || orden === "" || Number.isNaN(Number(orden)) || !Number.isInteger(Number(orden))) {
      throw httpError(400, "orden debe ser un número entero.");
    }
    ordenNormalizado = Number(orden);
  }

  return { stock: stockNormalizado, destacado: destacadoNormalizado, orden: ordenNormalizado };
}

function validarArchivos({ fotosNuevas, fotosExistentesCount, video }) {
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

/** Normaliza la respuesta de `cloudinary.subirArchivo` a lo que guarda la DB. */
function aArchivoSubido({ cloudinaryPublicId, cloudinaryResourceType, url }) {
  return { cloudinaryPublicId, cloudinaryResourceType, url };
}

/**
 * Sube a Cloudinary las fotos nuevas y el video opcional, TODOS EN PARALELO,
 * y devuelve sus metadatos para las escrituras en la base.
 *
 * Por qué en paralelo: antes era un `for` con `await` adentro, así que diez
 * fotos de ~2s cada una eran un request de ~20s. Además, cuanto más larga la
 * subida, más expuesta queda al timeout de inactividad de 60s del SDK
 * (`cloudinary.service.js`) que ya nos mordió en producción.
 *
 * Sin límite de concurrencia a propósito: `validarArchivos` ya acota la tanda
 * a `MAX_FOTOS` fotos + 1 video (11 requests como techo absoluto), y multer
 * guarda los buffers en memoria antes de llegar acá, así que serializar no
 * ahorraría ni una sola conexión en vuelo *menos* memoria — solo tiempo de
 * pared. Un tope artificial acá volvería a serializar sin beneficio.
 *
 * CONTRATO ANTI-HUÉRFANOS (design D6, heredado del código de la era Drive):
 * si alguna subida falla, las que sí terminaron bien se borran de Cloudinary
 * para no dejar archivos sueltos que ya nadie referencia.
 *
 * Es `Promise.allSettled` y NO `Promise.all` por ese contrato: `Promise.all`
 * rechaza apenas falla una y devuelve el control mientras las otras SIGUEN EN
 * VUELO — esas terminarían después de la limpieza y quedarían huérfanas justo
 * en el caso que el contrato existe para cubrir. `allSettled` espera a que
 * todas se asienten, así la limpieza ve la lista completa de subidas
 * exitosas. Es también el motivo por el que el paralelo es MÁS expuesto que
 * el bucle secuencial, donde una falla simplemente impedía que arrancaran las
 * siguientes.
 *
 * El orden de `fotosSubidas` es el orden de entrada, nunca el de finalización:
 * la posición de una foto es contenido (`fotos[0]` es la portada, `fotos[1]`
 * es la imagen de "¿qué problema resuelve?"), y `ordenFotos` indexa este array
 * por posición. Por eso se arma con `map` sobre los resultados —que
 * `allSettled` devuelve en el orden en que se pasaron las promesas— y nunca
 * con `push` desde un callback.
 */
async function subirArchivosNuevos({ fotosNuevas, videoNuevo, folder }) {
  const resultados = await Promise.allSettled([
    ...fotosNuevas.map((foto) => cloudinary.subirArchivo(foto.buffer, "image", folder)),
    ...(videoNuevo ? [cloudinary.subirArchivo(videoNuevo.buffer, "video", folder)] : []),
  ]);

  const resultadosFotos = resultados.slice(0, fotosNuevas.length);
  const resultadoVideo = videoNuevo ? resultados[fotosNuevas.length] : null;

  const fallo = resultados.find((r) => r.status === "rejected");
  if (fallo) {
    await limpiarArchivosSubidos({
      fotos: resultadosFotos.filter((r) => r.status === "fulfilled").map((r) => aArchivoSubido(r.value)),
      video: resultadoVideo?.status === "fulfilled" ? aArchivoSubido(resultadoVideo.value) : null,
    });
    // Se propaga el primer rechazo en orden de entrada, no el primero en el
    // tiempo: el mensaje que ve el admin queda estable ante el azar de la red.
    throw fallo.reason;
  }

  return {
    fotosSubidas: resultadosFotos.map((r) => aArchivoSubido(r.value)),
    videoSubido: resultadoVideo ? aArchivoSubido(resultadoVideo.value) : null,
  };
}

/**
 * Registra una falla de limpieza de media (Cloudinary/Drive) en el ErrorLog
 * central, en vez del `console.error` suelto que había antes.
 *
 * Por qué estas fallas NO son un 500: la mutación de negocio (crear, editar o
 * borrar el producto) ya se completó y el cliente ya tiene su respuesta. Lo
 * único que falló es el borrado del archivo remoto, que deja un huérfano en
 * el storage — molesto y hay que poder verlo, pero no invalida la operación.
 * Antes ese rastro moría en los logs del contenedor; ahora queda consultable
 * desde el panel admin igual que cualquier otro error.
 *
 * `status: null` a propósito: no hay un status HTTP asociado (la respuesta al
 * cliente fue exitosa). `req` es opcional porque `limpiarArchivosSubidos` se
 * llama desde catch blocks que no siempre lo tienen a mano.
 *
 * Fire-and-forget, igual que el resto de los usos de `logError`.
 */
function logFallaDeLimpieza(mensaje, err, req) {
  logError({
    mensaje: `${mensaje}: ${err?.message ?? err}`,
    stack: err?.stack,
    ruta: req?.originalUrl,
    metodo: req?.method,
    status: null,
  });
}

/**
 * Limpieza best-effort de una tanda recién subida a Cloudinary — nunca lanza,
 * se usa desde catch blocks. Los borrados van en paralelo por el mismo motivo
 * que las subidas: son N round trips independientes contra un servicio
 * externo, y acá el cliente ya está esperando la respuesta de un request que
 * además falló.
 *
 * Cada borrado lleva su propio `catch`, así que `Promise.all` no puede
 * rechazar; igual se usa `allSettled` para que un fallo imprevisto (por
 * ejemplo un throw sincrónico del SDK) no corte la limpieza de los demás.
 */
async function limpiarArchivosSubidos({ fotos = [], video = null }, req) {
  const borrarConAviso = (archivo, descripcion) =>
    cloudinary
      .eliminarArchivo(archivo.cloudinaryPublicId, archivo.cloudinaryResourceType)
      .catch((err) =>
        logFallaDeLimpieza(`${descripcion} (${archivo.cloudinaryPublicId})`, err, req),
      );

  await Promise.allSettled([
    ...fotos.map((foto) => borrarConAviso(foto, "No se pudo limpiar la foto huérfana en Cloudinary")),
    ...(video ? [borrarConAviso(video, "No se pudo limpiar el video huérfano en Cloudinary")] : []),
  ]);
}

/**
 * Borra el archivo remoto de una foto o video YA eliminado de la base,
 * contra el storage que esa fila usaba: Drive para las filas legado,
 * Cloudinary para todo lo posterior a la migración (una fila tiene
 * exactamente uno de los dos ids seteado, nunca ambos).
 *
 * Devuelve una promesa que nunca rechaza — la falla se registra en el
 * ErrorLog y se traga, porque la mutación de negocio ya se completó y el
 * único daño posible es un archivo huérfano en el storage. Devolver la
 * promesa (en vez de esperarla adentro) es lo que deja a los llamadores
 * juntar varias limpiezas en un solo `Promise.allSettled`.
 *
 * @param {{driveFileId?: string|null, cloudinaryPublicId?: string|null, cloudinaryResourceType?: string|null}|null} media
 * @param {string} que - sujeto del mensaje de error, ej. "la foto".
 * @param {import("express").Request} [req]
 * @returns {Promise<void>}
 */
function limpiarMediaRemota(media, que, req) {
  if (media?.driveFileId) {
    return googleDrive
      .eliminarArchivo(media.driveFileId)
      .catch((err) => logFallaDeLimpieza(`No se pudo eliminar ${que} en Drive`, err, req));
  }
  if (media?.cloudinaryPublicId) {
    return cloudinary
      .eliminarArchivo(media.cloudinaryPublicId, media.cloudinaryResourceType)
      .catch((err) => logFallaDeLimpieza(`No se pudo eliminar ${que} en Cloudinary`, err, req));
  }
  return Promise.resolve();
}

/**
 * Builds the `where` clause for `listar()` from optional query-string
 * filters (categoria, search, minPrecio/maxPrecio).
 *
 * Malformed values are never a 400/500 on this browse endpoint — a bad
 * `?minPrecio=abc` from a stale link or a fumbled UI control just silently
 * drops that one filter instead of failing the whole listing. Each filter is
 * validated independently before being added.
 *
 * `visibleEnCatalogo: true` (when not in admin mode) is inserted FIRST so it
 * stays the leading key of the `where` object — there's a SQL Server index
 * on `[visibleEnCatalogo, orden]` and this keeps queries aligned with it.
 *
 * `stock: { gt: 0 }` (also only outside admin mode): a product that reached
 * zero stock stops appearing in the public LISTING, so it doesn't take up a
 * slot in the grid. Its detail page stays reachable though (see
 * `obtenerPorId`), showing an "Agotado" badge with the buy CTA disabled — a
 * shared link to an out-of-stock product must not 404. The admin listing
 * still needs to see it (to restock or edit it), so this exclusion is
 * public-only, same as `visibleEnCatalogo`.
 */
function construirFiltrosListado(query, { esAdmin }) {
  const where = {};
  if (!esAdmin) {
    where.visibleEnCatalogo = true;
    where.stock = { gt: 0 };
  }

  if (query.categoria !== undefined) {
    const categoriaId = Number(query.categoria);
    if (!Number.isNaN(categoriaId)) where.categoriaId = categoriaId;
  }

  if (typeof query.search === "string" && query.search !== "") {
    // No `mode: "insensitive"` here on purpose: this database's default
    // collation is SQL_Latin1_General_CP1_CI_AS (case-insensitive already,
    // confirmed live against the dev SQL Server), and the mssql Prisma
    // connector doesn't support the `mode` option at all — passing it
    // throws "Unknown argument mode" at runtime. Plain `contains` is both
    // correct and the only option here.
    where.nombre = { contains: query.search };
  }

  const rangoPrecio = {};
  if (query.minPrecio !== undefined) {
    const min = Number(query.minPrecio);
    if (!Number.isNaN(min)) rangoPrecio.gte = min;
  }
  if (query.maxPrecio !== undefined) {
    const max = Number(query.maxPrecio);
    if (!Number.isNaN(max)) rangoPrecio.lte = max;
  }
  if (Object.keys(rangoPrecio).length > 0) where.precio = rangoPrecio;

  return Object.keys(where).length > 0 ? where : undefined;
}

export async function listar(req, res, next) {
  try {
    const esAdmin = req.query.admin !== undefined;

    const productos = await prisma.product.findMany({
      where: construirFiltrosListado(req.query, { esAdmin }),
      include: PRODUCT_INCLUDE,
      orderBy: [{ orden: "asc" }, { createdAt: "desc" }],
    });
    res.json(productos.map(mapProducto));
  } catch (err) {
    next(err);
  }
}

/**
 * Fetches up to 4 related products for the detail page: same categoriaId OR
 * same etiqueta as the current product (either match counts, not both),
 * excluding the product itself. Short-circuits to `[]` without a DB
 * round-trip when the product has neither field set — that's a normal case
 * (nothing to match on), not an error.
 *
 * Only one level deep: related rows are mapped with plain `mapProducto` and
 * never get their own `relacionados` computed, avoiding recursion.
 */
async function obtenerRelacionados(producto, { esAdmin }) {
  const { categoriaId, etiqueta } = producto;
  if (!categoriaId && !etiqueta) return [];

  const or = [];
  if (categoriaId) or.push({ categoriaId });
  if (etiqueta) or.push({ etiqueta });

  const where = {
    id: { not: producto.id },
    OR: or,
    ...(esAdmin ? {} : { visibleEnCatalogo: true, stock: { gt: 0 } }),
  };

  const relacionados = await prisma.product.findMany({
    where,
    include: PRODUCT_INCLUDE,
    take: 4,
  });

  return relacionados.map(mapProducto);
}

export async function obtenerPorId(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const existe = await prisma.product.findUnique({ where: { id } });
    if (!existe) throw httpError(404, "Producto no encontrado.");

    // Admin edit-form prefills also hit this endpoint but aren't a real
    // visitor view — ?admin=1 (set by AdminProductoForm.jsx) skips the
    // increment so an admin editing a product doesn't inflate its own count.
    const esAdmin = req.query.admin !== undefined;

    // Un producto agotado (`stock <= 0`) SÍ es visible en su ficha de detalle:
    // el visitante ve que existe, con el badge "Agotado" y sin poder comprarlo.
    // Solo se lo excluye del listado público (ver `construirFiltrosListado`),
    // así no ocupa lugar en la grilla pero su link compartido sigue abriendo.
    // `visibleEnCatalogo: false` sí sigue siendo 404: eso es el admin ocultando
    // el producto a propósito, distinto de quedarse sin stock.
    if (!esAdmin && !existe.visibleEnCatalogo) {
      throw httpError(404, "Producto no encontrado.");
    }

    let producto;
    if (esAdmin) {
      producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    } else {
      producto = await prisma.product.update({
        where: { id },
        data: { vistas: { increment: 1 } },
        include: PRODUCT_INCLUDE,
      });
      // El evento es ADITIVO al contador `vistas`, no lo reemplaza: el contador
      // da el total acumulado, el evento agrega el cuándo y el de-dónde para el
      // análisis de tráfico. Va acá adentro a propósito, atado a la misma
      // condición `!esAdmin` que el incremento — un admin abriendo el form de
      // edición no genera una vista. Fire-and-forget: la respuesta no espera.
      logEvento({ tipo: "VISTA_PRODUCTO", productId: id, ...headersDeEvento(req) });
    }

    const relacionados = await obtenerRelacionados(producto, { esAdmin });

    res.json({ ...mapProducto(producto), relacionados });
  } catch (err) {
    next(err);
  }
}

export async function compartir(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const existe = await prisma.product.findUnique({ where: { id } });
    if (!existe) throw httpError(404, "Producto no encontrado.");

    await prisma.product.update({ where: { id }, data: { compartidos: { increment: 1 } } });

    // Aditivo al contador `compartidos` (ver `obtenerPorId`), fire-and-forget.
    logEvento({ tipo: "COMPARTIDO", productId: id, ...headersDeEvento(req) });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function favorito(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const existe = await prisma.product.findUnique({ where: { id } });
    if (!existe) throw httpError(404, "Producto no encontrado.");

    await prisma.product.update({ where: { id }, data: { favoritosCount: { increment: 1 } } });

    // Aditivo al contador `favoritosCount` (ver `obtenerPorId`), fire-and-forget.
    logEvento({ tipo: "FAVORITO_AGREGADO", productId: id, ...headersDeEvento(req) });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  let subidas = null;
  let producto = null;
  try {
    const {
      nombre, descripcion, precio, etiqueta, categoriaId, stock, destacado, orden,
      fraseComercial, porQueLoVasAQuerer, tePasaEsto,
    } = req.body;
    validarCamposBase({ nombre, descripcion, precio }, { esCreacion: true });
    const merchandising = validarCamposMerchandising({ stock, destacado, orden });

    const caracteristicas = parseCaracteristicas(req.body.caracteristicas) ?? [];
    const beneficios = parseListas(req.body.beneficios, "BENEFICIO") ?? [];
    const usos = parseListas(req.body.usos, "USO") ?? [];
    const idealPara = parseListas(req.body.idealPara, "IDEAL_PARA") ?? [];
    const incluye = parseListas(req.body.incluye, "INCLUYE") ?? [];
    const especificaciones = parseEspecificaciones(req.body.especificaciones) ?? [];
    const fotosNuevas = req.files?.fotos ?? [];
    const videoArr = req.files?.video ?? [];

    validarArchivos({ fotosNuevas, fotosExistentesCount: 0, video: videoArr });

    // Create the DB row first (no media yet) so we have a real id — this
    // ordering originally existed to name the product's Drive subfolder
    // (design item 1's ordering fix), and still serves the same purpose for
    // Cloudinary's per-product folder below. Also relied on for the
    // orphan-prevention behavior below (a media-less product row is an
    // accepted partial state on upload failure).
    //
    // sku is NOT NULL + unique, so it must be generated up front (it can't
    // depend on the id, which doesn't exist yet at this point). A handful of
    // retries absorbs the rare random-suffix collision (P2002 on sku)
    // instead of failing the whole request over it.
    const MAX_INTENTOS_SKU = 5;
    for (let intento = 1; intento <= MAX_INTENTOS_SKU; intento++) {
      try {
        producto = await prisma.product.create({
          data: {
            nombre: nombre.trim(),
            descripcion: descripcion.trim(),
            precio: String(precio),
            etiqueta: etiqueta?.trim() || null,
            categoriaId: categoriaId ? Number(categoriaId) : null,
            sku: generarSku(nombre.trim()),
            stock: merchandising.stock ?? 0,
            destacado: merchandising.destacado ?? false,
            orden: merchandising.orden ?? 0,
            caracteristicas: { create: caracteristicas },
            fraseComercial: fraseComercial?.trim() || null,
            porQueLoVasAQuerer: porQueLoVasAQuerer?.trim() || null,
            tePasaEsto: tePasaEsto?.trim() || null,
            listas: {
              create: [
                ...beneficios.map((item, index) => ({ ...item, orden: index })),
                ...usos.map((item, index) => ({ ...item, orden: index })),
                ...idealPara.map((item, index) => ({ ...item, orden: index })),
                ...incluye.map((item, index) => ({ ...item, orden: index })),
              ],
            },
            especificaciones: { create: especificaciones.map((e, index) => ({ ...e, orden: index })) },
          },
          include: PRODUCT_INCLUDE,
        });
        break;
      } catch (err) {
        const esColisionSku = err?.code === "P2002" && err.meta?.target?.includes?.("sku");
        if (!esColisionSku || intento === MAX_INTENTOS_SKU) throw err;
      }
    }

    // No hay un paso previo de "crear carpeta" como tenía Drive: Cloudinary
    // la crea implícitamente al recibir `folder` en la subida.
    //
    // Cloudinary organizes uploads by product, mirroring Drive's old
    // per-product subfolder — see cloudinary.service.js's subirArchivo doc.
    const folder = `productos/${producto.id}-${sanitizarNombreParaCarpeta(nombre.trim())}`;

    subidas = await subirArchivosNuevos({ fotosNuevas, videoNuevo: videoArr[0] ?? null, folder });
    const { fotosSubidas, videoSubido } = subidas;

    producto = await prisma.product.update({
      where: { id: producto.id },
      data: {
        fotos: {
          create: fotosSubidas.map((f, index) => ({
            url: f.url,
            cloudinaryPublicId: f.cloudinaryPublicId,
            cloudinaryResourceType: f.cloudinaryResourceType,
            orden: index,
          })),
        },
        video: videoSubido
          ? {
              create: {
                url: videoSubido.url,
                cloudinaryPublicId: videoSubido.cloudinaryPublicId,
                cloudinaryResourceType: videoSubido.cloudinaryResourceType,
              },
            }
          : undefined,
      },
      include: PRODUCT_INCLUDE,
    });

    // Fire-and-forget: la respuesta no espera el insert de auditoría.
    logAudit(req, {
      accion: "CREAR",
      entidad: "Producto",
      entidadId: producto.id,
      detalle: { nombre: producto.nombre, sku: producto.sku },
    });

    res.status(201).json(mapProducto(producto));
  } catch (err) {
    // Orphan prevention (design D6): clean up any Cloudinary uploads from
    // this batch. The product DB row (if created) is intentionally NOT rolled
    // back — per design item 1, a partially-created product (no media) is
    // an accepted state the admin can fix by editing.
    if (subidas) await limpiarArchivosSubidos({ fotos: subidas.fotosSubidas, video: subidas.videoSubido }, req);
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const existente = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const {
      nombre, descripcion, precio, etiqueta, categoriaId, stock, destacado, orden,
      fraseComercial, porQueLoVasAQuerer, tePasaEsto,
    } = req.body;
    validarCamposBase({ nombre, descripcion, precio }, { esCreacion: false });
    const merchandising = validarCamposMerchandising({ stock, destacado, orden });

    const caracteristicas = parseCaracteristicas(req.body.caracteristicas);
    const beneficios = parseListas(req.body.beneficios, "BENEFICIO");
    const usos = parseListas(req.body.usos, "USO");
    const idealPara = parseListas(req.body.idealPara, "IDEAL_PARA");
    const incluye = parseListas(req.body.incluye, "INCLUYE");
    const especificaciones = parseEspecificaciones(req.body.especificaciones);
    const fotosExistentesIds = parseFotosExistentes(req.body.fotosExistentes) ?? existente.fotos.map((f) => f.id);
    const fotosNuevas = req.files?.fotos ?? [];
    const videoArr = req.files?.video ?? [];
    const eliminarVideo = req.body.eliminarVideo === "true";

    validarArchivos({ fotosNuevas, fotosExistentesCount: fotosExistentesIds.length, video: videoArr });

    // Photos removed by the client (present before, absent from fotosExistentes) get deleted from Drive too.
    const fotosARemover = existente.fotos.filter((f) => !fotosExistentesIds.includes(f.id));

    // Se valida ANTES de subir nada a Cloudinary: si la secuencia es
    // inconsistente conviene fallar con 400 sin haber dejado archivos huérfanos.
    const ordenFotos = parsearOrdenFotos(req.body.ordenFotos);
    validarOrdenFotos(ordenFotos, {
      idsConservados: existente.fotos.filter((f) => fotosExistentesIds.includes(f.id)).map((f) => f.id),
      cantidadNuevas: fotosNuevas.length,
    });

    // Toda subida nueva, sobre CUALQUIER producto (nuevo o legado con media
    // en Drive), va a Cloudinary, agrupada en la carpeta propia del producto
    // — misma idea de agrupación por producto que la subcarpeta de Drive,
    // otro storage. Las fotos que un producto legado YA tiene en Drive quedan
    // intactas: esto solo decide dónde aterriza una subida NUEVA.
    const folder = `productos/${existente.id}-${sanitizarNombreParaCarpeta((nombre ?? existente.nombre).trim())}`;

    const subidas = await subirArchivosNuevos({
      fotosNuevas,
      videoNuevo: videoArr[0] ?? null,
      folder,
    });
    const { fotosSubidas, videoSubido } = subidas;

    let productoActualizado;
    try {
      productoActualizado = await prisma.$transaction(async (tx) => {
        // Text fields
        await tx.product.update({
          where: { id },
          data: {
            nombre: nombre !== undefined ? nombre.trim() : undefined,
            descripcion: descripcion !== undefined ? descripcion.trim() : undefined,
            precio: precio !== undefined ? String(precio) : undefined,
            etiqueta: etiqueta !== undefined ? etiqueta?.trim() || null : undefined,
            categoriaId: categoriaId !== undefined ? (categoriaId ? Number(categoriaId) : null) : undefined,
            stock: merchandising.stock,
            destacado: merchandising.destacado,
            orden: merchandising.orden,
            fraseComercial: fraseComercial !== undefined ? fraseComercial?.trim() || null : undefined,
            porQueLoVasAQuerer: porQueLoVasAQuerer !== undefined ? porQueLoVasAQuerer?.trim() || null : undefined,
            tePasaEsto: tePasaEsto !== undefined ? tePasaEsto?.trim() || null : undefined,
          },
        });

        // Caracteristicas: full replace when provided
        if (caracteristicas !== undefined) {
          await tx.caracteristica.deleteMany({ where: { productId: id } });
          if (caracteristicas.length > 0) {
            await tx.caracteristica.createMany({
              data: caracteristicas.map((c) => ({ ...c, productId: id })),
            });
          }
        }

        // Listas comerciales: full replace per-tipo, only when provided
        for (const [tipo, items] of [
          ["BENEFICIO", beneficios],
          ["USO", usos],
          ["IDEAL_PARA", idealPara],
          ["INCLUYE", incluye],
        ]) {
          if (items === undefined) continue;
          await tx.productoLista.deleteMany({ where: { productId: id, tipo } });
          if (items.length > 0) {
            await tx.productoLista.createMany({
              data: items.map((item, index) => ({ ...item, orden: index, productId: id })),
            });
          }
        }

        // Especificaciones: full replace when provided
        if (especificaciones !== undefined) {
          await tx.especificacion.deleteMany({ where: { productId: id } });
          if (especificaciones.length > 0) {
            await tx.especificacion.createMany({
              data: especificaciones.map((e, index) => ({ ...e, orden: index, productId: id })),
            });
          }
        }

        // Fotos: remove any not in fotosExistentesIds, keep the rest, append new ones, re-normalize orden
        if (fotosARemover.length > 0) {
          await tx.foto.deleteMany({ where: { id: { in: fotosARemover.map((f) => f.id) } } });
        }
        const fotosConservadas = existente.fotos.filter((f) => fotosExistentesIds.includes(f.id));

        if (ordenFotos) {
          // Secuencia explícita: la posición en el array ES el `orden` final,
          // así una foto recién subida puede quedar de portada por delante de
          // las que ya estaban.
          const nuevasPorIndice = fotosSubidas;
          const aCrear = [];

          for (const [posicion, token] of ordenFotos.entries()) {
            if (token.tipo === "existente") {
              await tx.foto.update({ where: { id: token.id }, data: { orden: posicion } });
            } else {
              const subida = nuevasPorIndice[token.index];
              aCrear.push({
                url: subida.url,
                cloudinaryPublicId: subida.cloudinaryPublicId,
                cloudinaryResourceType: subida.cloudinaryResourceType,
                orden: posicion,
                productId: id,
              });
            }
          }

          if (aCrear.length > 0) {
            await tx.foto.createMany({ data: aCrear });
          }
        } else {
          // Sin secuencia explícita: comportamiento histórico — se conserva el
          // orden que ya tenían y las nuevas van al final.
          const ordenBase = fotosConservadas.length;
          for (const [index, foto] of fotosConservadas.entries()) {
            await tx.foto.update({ where: { id: foto.id }, data: { orden: index } });
          }
          if (fotosSubidas.length > 0) {
            await tx.foto.createMany({
              data: fotosSubidas.map((f, index) => ({
                url: f.url,
                cloudinaryPublicId: f.cloudinaryPublicId,
                cloudinaryResourceType: f.cloudinaryResourceType,
                orden: ordenBase + index,
                productId: id,
              })),
            });
          }
        }

        // Video: replace, remove, or leave unchanged
        if (videoSubido) {
          if (existente.video) {
            await tx.video.update({
              where: { productId: id },
              data: {
                url: videoSubido.url,
                cloudinaryPublicId: videoSubido.cloudinaryPublicId,
                cloudinaryResourceType: videoSubido.cloudinaryResourceType,
              },
            });
          } else {
            await tx.video.create({
              data: {
                url: videoSubido.url,
                cloudinaryPublicId: videoSubido.cloudinaryPublicId,
                cloudinaryResourceType: videoSubido.cloudinaryResourceType,
                productId: id,
              },
            });
          }
        } else if (eliminarVideo && existente.video) {
          await tx.video.delete({ where: { productId: id } });
        }

        return tx.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
      });
    } catch (dbErr) {
      // Orphan prevention (design D6): DB write failed after successful Cloudinary upload(s).
      await limpiarArchivosSubidos({ fotos: fotosSubidas, video: videoSubido }, req);
      throw dbErr;
    }

    // DB writes succeeded — now clean up whichever storage backend each
    // removed photo/video actually used. Van todas en paralelo: son hasta 11
    // round trips independientes contra Cloudinary/Drive y el cliente está
    // esperando la respuesta detrás de ellos. Ninguna puede rechazar
    // (`limpiarMediaRemota` traga y registra), así que el `allSettled` solo
    // cubre un throw imprevisto del SDK.
    const limpiezas = fotosARemover.map((foto) => limpiarMediaRemota(foto, "la foto", req));
    if (videoSubido && existente.video) {
      limpiezas.push(limpiarMediaRemota(existente.video, "el video anterior", req));
    } else if (eliminarVideo && existente.video) {
      limpiezas.push(limpiarMediaRemota(existente.video, "el video", req));
    }
    await Promise.allSettled(limpiezas);

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        nombreAnterior: existente.nombre,
        nombreNuevo: productoActualizado.nombre,
        precioAnterior: String(existente.precio),
        precioNuevo: String(productoActualizado.precio),
        stockAnterior: existente.stock,
        stockNuevo: productoActualizado.stock,
      },
    });

    res.json(mapProducto(productoActualizado));
  } catch (err) {
    next(err);
  }
}

export async function actualizarVisibilidad(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const { visibleEnCatalogo } = req.body;
    if (typeof visibleEnCatalogo !== "boolean") {
      throw httpError(400, "visibleEnCatalogo debe ser true o false.");
    }

    const existente = await prisma.product.findUnique({ where: { id } });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.update({
      where: { id },
      data: { visibleEnCatalogo },
      include: PRODUCT_INCLUDE,
    });

    logAudit(req, {
      accion: "ACTUALIZAR_VISIBILIDAD",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        visibleAnterior: existente.visibleEnCatalogo,
        visibleNuevo: producto.visibleEnCatalogo,
      },
    });

    res.json(mapProducto(producto));
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /:id/merchandising — combined endpoint for the two admin-table
 * quick-edit controls (`destacado` toggle, `orden` input), mirroring
 * `actualizarVisibilidad`'s shape. Accepts JSON, so `destacado` arrives as a
 * real boolean here (unlike crear()/actualizar()'s multipart/form-data,
 * where it arrives as a string) — `validarCamposMerchandising()` handles
 * both shapes via `coerceDestacado()`, so this endpoint reuses the same
 * validator as crear()/actualizar() instead of re-checking the rules here.
 * At least one of the two fields must be present; each provided field is
 * validated and written, any omitted field is left untouched.
 */
export async function actualizarMerchandising(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const { destacado, orden } = req.body;

    if (destacado === undefined && orden === undefined) {
      throw httpError(400, "Debe enviar destacado y/o orden.");
    }
    const merchandising = validarCamposMerchandising({ destacado, orden });

    const existente = await prisma.product.findUnique({ where: { id } });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.update({
      where: { id },
      data: { destacado: merchandising.destacado, orden: merchandising.orden },
      include: PRODUCT_INCLUDE,
    });

    logAudit(req, {
      accion: "ACTUALIZAR_MERCHANDISING",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        destacadoAnterior: existente.destacado,
        destacadoNuevo: producto.destacado,
        ordenAnterior: existente.orden,
        ordenNuevo: producto.orden,
      },
    });

    res.json(mapProducto(producto));
  } catch (err) {
    next(err);
  }
}

export async function eliminar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!producto) throw httpError(404, "Producto no encontrado.");

    // Pre-chequeo del historial de ventas, mismo criterio que
    // `categorias.controller.js` con los productos de una categoría.
    //
    // `ItemOrden.product` es `onDelete: NoAction`, así que borrar un producto
    // vendido explota con el error P2003 de Prisma (violación de FK), que el
    // error handler central de `server.js` no mapea: al admin le llegaba un
    // 500 con "Error interno del servidor." y ninguna pista de qué hacer.
    // Preguntando primero se responde un 400 que explica el problema y ofrece
    // la salida correcta (ocultarlo del catálogo en vez de borrarlo).
    //
    // El conteo es barato: `ItemOrden.productId` está indexado.
    const cantidadVentas = await prisma.itemOrden.count({ where: { productId: id } });
    if (cantidadVentas > 0) {
      throw httpError(
        400,
        `No se puede eliminar: el producto aparece en ${cantidadVentas} ${cantidadVentas === 1 ? "orden" : "órdenes"} de compra. ` +
          "Para sacarlo del catálogo sin perder el historial de ventas, ocultalo desde el listado de productos.",
      );
    }

    // DB delete first (design D6/ordering): a dangling DB row is worse than an orphaned Drive file.
    await prisma.product.delete({ where: { id } });

    // Se audita apenas la fila se borró, antes de la limpieza de media: el
    // borrado ya es irreversible en este punto, y la limpieza de Cloudinary/
    // Drive puede fallar sin invalidar el hecho de que el producto se eliminó.
    logAudit(req, {
      accion: "ELIMINAR",
      entidad: "Producto",
      entidadId: id,
      detalle: { nombre: producto.nombre, sku: producto.sku },
    });

    // Always sweep individual files first — a product may have a
    // driveFolderId AND still have some fotos/video whose driveFileId
    // predates that folder (e.g. a legacy product that was edited once
    // after this feature shipped: the new upload went into a fresh
    // subfolder, but its original photos are still in the flat root
    // folder). Deleting the folder alone would leave those orphaned.
    //
    // Los archivos se barren en paralelo (hasta 10 fotos + 1 video), pero el
    // borrado de las carpetas SIGUE SIENDO POSTERIOR y no se puede meter en
    // la misma tanda: `delete_folder` de la Admin API de Cloudinary solo
    // funciona sobre una carpeta vacía, así que adelantarlo la dejaría viva
    // para siempre.
    await Promise.allSettled([
      ...producto.fotos.map((foto) => limpiarMediaRemota(foto, "la foto", req)),
      ...(producto.video ? [limpiarMediaRemota(producto.video, "el video", req)] : []),
    ]);

    // Then remove the (now-empty, or never-used) per-product folders. The
    // Drive one only ever exists for legacy Drive-era products — Cloudinary
    // uploads never create one. La carpeta de Cloudinary usa la misma
    // fórmula de nombre que crear/actualizar, así coincide sin importar
    // cuándo se subió por última vez la media del producto.
    const carpetaCloudinary = `productos/${producto.id}-${sanitizarNombreParaCarpeta(producto.nombre.trim())}`;
    await Promise.allSettled([
      ...(producto.driveFolderId
        ? [
            googleDrive
              .eliminarArchivo(producto.driveFolderId)
              .catch((err) => logFallaDeLimpieza("No se pudo eliminar la carpeta del producto en Drive", err, req)),
          ]
        : []),
      cloudinary
        .eliminarCarpeta(carpetaCloudinary)
        .catch((err) => logFallaDeLimpieza("No se pudo eliminar la carpeta del producto en Cloudinary", err, req)),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

const DEFAULT_VIDEO_MIME = "video/mp4";

/**
 * Streams a product's video through the backend, proxying Drive's
 * `alt=media` response byte-for-byte (design D1/D3). Video is NEVER a public
 * Drive URL — this route is the only way the frontend plays it.
 *
 * Forwards an incoming `Range` header to Drive and mirrors whatever Drive
 * answers: 206 + Content-Range for a satisfied range request, or a plain
 * 200 with the full body otherwise. `Accept-Ranges: bytes` is always set so
 * the browser knows it can issue ranged requests for `<video>` seeking, even
 * on the very first (rangeless) request.
 *
 * Header caveat (resolved this PR — see apply-progress for the investigation):
 * the response object returned by `googleDrive.obtenerStreamVideo` uses a
 * fetch-style `Headers` instance for `.headers` (gaxios), NOT a plain object.
 * `JSON.stringify`/bracket access (`headers["content-range"]`) look empty
 * because `Headers` has no own enumerable properties — but `.get(name)`
 * works correctly and returns the real values. Always use `.get(...)`.
 */
export async function streamVideo(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.findUnique({ where: { id }, include: { video: true } });
    if (!producto) throw httpError(404, "Producto no encontrado.");
    if (!producto.video) throw httpError(404, "Este producto no tiene video.");
    if (!producto.video.driveFileId) throw httpError(404, "El video de este producto no está disponible.");

    const rangeHeader = req.headers.range;

    let driveResponse;
    try {
      driveResponse = await googleDrive.obtenerStreamVideo(producto.video.driveFileId, rangeHeader);
    } catch (driveErr) {
      const driveStatus = driveErr?.code ?? driveErr?.response?.status;
      if (driveStatus === 404) throw httpError(404, "El video de este producto no está disponible.");
      throw httpError(502, "No se pudo obtener el video desde Google Drive.");
    }

    const { stream, status, headers } = driveResponse;
    const contentType = headers.get("content-type") || DEFAULT_VIDEO_MIME;
    const contentRange = headers.get("content-range");
    const contentLength = headers.get("content-length");

    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);

    if (rangeHeader && status === 206 && contentRange) {
      res.status(206);
      res.setHeader("Content-Range", contentRange);
    } else {
      res.status(200);
    }

    // If the client disconnects mid-stream (e.g. scrubber jumps again before
    // the previous range finished), abort the upstream Drive stream instead
    // of leaking it.
    req.on("close", () => {
      if (!res.writableEnded) stream.destroy();
    });
    stream.on("error", (streamErr) => {
      logError({
        mensaje: `Error al transmitir el video desde Drive: ${streamErr.message}`,
        stack: streamErr.stack,
        ruta: req.originalUrl,
        metodo: req.method,
        status: 502,
      });
      if (!res.headersSent) {
        res.status(502).json({ error: "No se pudo transmitir el video desde Google Drive." });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

const DEFAULT_FOTO_MIME = "image/jpeg";

/**
 * Streams a product photo through the backend, proxying Drive's `alt=media`
 * response (post-archive bugfix — see `mapProducto`'s comment and topic
 * "sdd/backend-drive-sqlserver/photo-proxy-postfix" for the ORB root cause).
 *
 * Mirrors `streamVideo`'s piping mechanics but simpler: photos are not
 * seekable media, so there is no Range/206 handling — always a plain 200
 * with the full body. Seed/placeholder photos (driveFileId null) 404 here;
 * they are never linked through this route because `mapProducto` keeps
 * their original `placehold.co` URL.
 */
export async function streamFoto(req, res, next) {
  try {
    const id = Number(req.params.id);
    const fotoId = Number(req.params.fotoId);
    if (Number.isNaN(id) || Number.isNaN(fotoId)) throw httpError(404, "Producto o foto no encontrados.");

    const foto = await prisma.foto.findFirst({ where: { id: fotoId, productId: id } });
    if (!foto) throw httpError(404, "Foto no encontrada.");
    if (!foto.driveFileId) throw httpError(404, "Esta foto no está disponible.");

    let driveResponse;
    try {
      driveResponse = await googleDrive.obtenerStreamArchivo(foto.driveFileId);
    } catch (driveErr) {
      const driveStatus = driveErr?.code ?? driveErr?.response?.status;
      if (driveStatus === 404) throw httpError(404, "Esta foto no está disponible.");
      throw httpError(502, "No se pudo obtener la foto desde Google Drive.");
    }

    const { stream, headers } = driveResponse;
    const contentType = headers.get("content-type") || DEFAULT_FOTO_MIME;
    const contentLength = headers.get("content-length");

    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    res.status(200);

    req.on("close", () => {
      if (!res.writableEnded) stream.destroy();
    });
    stream.on("error", (streamErr) => {
      logError({
        mensaje: `Error al transmitir la foto desde Drive: ${streamErr.message}`,
        stack: streamErr.stack,
        ruta: req.originalUrl,
        metodo: req.method,
        status: 502,
      });
      if (!res.headersSent) {
        res.status(502).json({ error: "No se pudo transmitir la foto desde Google Drive." });
      } else {
        res.destroy();
      }
    });

    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}

export async function eliminarFoto(req, res, next) {
  try {
    const id = Number(req.params.id);
    const fotoId = Number(req.params.fotoId);
    if (Number.isNaN(id) || Number.isNaN(fotoId)) throw httpError(404, "Producto o foto no encontrados.");

    const producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!producto) throw httpError(404, "Producto no encontrado.");

    const foto = producto.fotos.find((f) => f.id === fotoId);
    if (!foto) throw httpError(404, "Foto no encontrada.");

    // DB delete first, then Drive cleanup (same ordering rationale as product delete).
    await prisma.$transaction(async (tx) => {
      await tx.foto.delete({ where: { id: fotoId } });
      const restantes = producto.fotos.filter((f) => f.id !== fotoId);
      for (const [index, f] of restantes.entries()) {
        await tx.foto.update({ where: { id: f.id }, data: { orden: index } });
      }
    });

    await limpiarMediaRemota(foto, "la foto", req);

    logAudit(req, {
      accion: "ELIMINAR_FOTO",
      entidad: "Producto",
      entidadId: id,
      detalle: { fotoId, nombreProducto: producto.nombre },
    });

    const productoActualizado = await prisma.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
    res.json(mapProducto(productoActualizado));
  } catch (err) {
    next(err);
  }
}

/**
 * `GET /api/products/import/template` — devuelve el `.xlsx` de plantilla con
 * los desplegables poblados con las categorías que existen ahora mismo.
 *
 * Sin caché a propósito: si el admin crea una categoría y vuelve a descargar
 * la plantilla, la categoría nueva tiene que aparecer en el desplegable.
 */
export async function descargarPlantilla(_req, res, next) {
  try {
    const categorias = await prisma.categoria.findMany({
      select: { nombre: true },
      orderBy: { nombre: "asc" },
    });

    const buffer = await generarPlantilla(categorias.map((c) => c.nombre));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="plantilla-productos.xlsx"');
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

/**
 * `POST /api/products/import` — crea N productos desde un `.xlsx`.
 *
 * Todo o nada: si una sola fila es inválida no se escribe nada. La alternativa
 * (importar las válidas) dejaría la base en un estado que el admin no puede
 * distinguir visualmente — los productos entran ocultos y sin fotos — y como
 * `Product.nombre` no es único, reintentar el archivo corregido duplicaría los
 * que sí habían entrado.
 *
 * Todos los productos entran con `visibleEnCatalogo: false` FORZADO: un
 * producto importado no tiene fotos todavía, y publicarlo lo mostraría como una
 * tarjeta rota en `/coleccion`. Publicar es una acción posterior y explícita.
 */
export async function importar(req, res, next) {
  try {
    if (!req.file) throw httpError(400, "Subí un archivo .xlsx con los productos.");

    // Una sola consulta para todas las filas, no una por fila.
    const categorias = await prisma.categoria.findMany({ select: { id: true, nombre: true } });
    const categoriasPorNombre = new Map(categorias.map((c) => [c.nombre.toLowerCase(), c.id]));

    let procesado;
    try {
      procesado = await procesarArchivo(req.file.buffer, categoriasPorNombre);
    } catch (err) {
      // Problema del ARCHIVO (vacío, sin la hoja, supera el límite): no tiene
      // fila a la que apuntar, así que es un 400 con mensaje suelto.
      throw httpError(400, err.message);
    }

    if (procesado.errores.length > 0) {
      return res.status(400).json({
        error: "El archivo tiene errores. No se importó ningún producto.",
        errores: procesado.errores,
      });
    }

    // `generarSku` usa un sufijo random de 4 dígitos: dos productos con nombres
    // parecidos en el mismo archivo pueden colisionar. `crear` absorbe eso
    // reintentando contra la base, pero acá todos los SKU se generan ANTES de
    // escribir, así que la colisión se resuelve en memoria: se regenera hasta
    // encontrar uno libre dentro del lote. Una colisión contra un SKU que ya
    // está en la base sigue cayendo en el P2002 del error handler central.
    const skusDelLote = new Set();
    const skuPorIndice = procesado.productos.map((producto) => {
      let sku = generarSku(producto.nombre);
      let intentos = 0;
      while (skusDelLote.has(sku) && intentos < 10) {
        sku = generarSku(producto.nombre);
        intentos += 1;
      }
      skusDelLote.add(sku);
      return sku;
    });

    const creados = await prisma.$transaction(
      procesado.productos.map((producto, indice) =>
        prisma.product.create({
          data: {
            nombre: producto.nombre,
            descripcion: producto.descripcion,
            precio: producto.precio,
            etiqueta: producto.etiqueta,
            categoriaId: producto.categoriaId,
            sku: skuPorIndice[indice],
            stock: producto.stock,
            visibleEnCatalogo: false,
            fraseComercial: producto.fraseComercial,
            porQueLoVasAQuerer: producto.porQueLoVasAQuerer,
            tePasaEsto: producto.tePasaEsto,
            caracteristicas: { create: producto.caracteristicas },
            listas: {
              create: [
                ...producto.beneficios.map((item, i) => ({ ...item, tipo: "BENEFICIO", orden: i })),
                ...producto.usos.map((item, i) => ({ ...item, tipo: "USO", orden: i })),
                ...producto.idealPara.map((item, i) => ({ ...item, tipo: "IDEAL_PARA", orden: i })),
                ...producto.incluye.map((item, i) => ({ ...item, tipo: "INCLUYE", orden: i })),
              ],
            },
            especificaciones: {
              create: producto.especificaciones.map((e, i) => ({ ...e, orden: i })),
            },
          },
          include: PRODUCT_INCLUDE,
        }),
      ),
    );

    logAudit(req, {
      accion: "IMPORTAR",
      entidad: "Producto",
      detalle: { cantidad: creados.length, skus: creados.map((p) => p.sku) },
    });

    res.status(201).json({ cantidad: creados.length, productos: creados.map(mapProducto) });
  } catch (err) {
    next(err);
  }
}
