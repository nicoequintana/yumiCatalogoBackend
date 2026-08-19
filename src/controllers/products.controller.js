import { prisma } from "../lib/prisma.js";
import * as googleDrive from "../services/googleDrive.service.js";
import * as cloudinary from "../services/cloudinary.service.js";
import { generarSku } from "../lib/sku.js";
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
    fotos: producto.fotos.map((f) => ({
      id: f.id,
      url: f.cloudinaryPublicId ? f.url : f.driveFileId ? `/api/products/${producto.id}/fotos/${f.id}` : f.url,
      driveFileId: f.driveFileId,
      orden: f.orden,
    })),
    video: producto.video
      ? {
          id: producto.video.id,
          url: producto.video.cloudinaryPublicId
            ? producto.video.url
            : `/api/products/${producto.id}/video`,
          driveFileId: producto.video.driveFileId,
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

/**
 * Uploads new photos + optional video to Cloudinary. Returns their
 * Cloudinary metadata for DB writes.
 *
 * MIGRATION NOTE (Cloudinary storage migration): this function used to
 * upload to Google Drive — see the commented-out version immediately below
 * for the original implementation, kept (not deleted) per an explicit
 * decision to preserve that work rather than lose it. New uploads go to
 * Cloudinary exclusively; existing Drive-backed products are untouched and
 * keep being served via the existing Drive proxy routes.
 */
async function subirArchivosNuevos({ fotosNuevas, videoNuevo, folder }) {
  const fotosSubidas = [];
  let videoSubido = null;

  try {
    for (const foto of fotosNuevas) {
      const { cloudinaryPublicId, cloudinaryResourceType, url } = await cloudinary.subirArchivo(
        foto.buffer,
        "image",
        folder,
      );
      fotosSubidas.push({ cloudinaryPublicId, cloudinaryResourceType, url });
    }

    if (videoNuevo) {
      const { cloudinaryPublicId, cloudinaryResourceType, url } = await cloudinary.subirArchivo(
        videoNuevo.buffer,
        "video",
        folder,
      );
      videoSubido = { cloudinaryPublicId, cloudinaryResourceType, url };
    }
  } catch (err) {
    // Orphan prevention (design D6, carried over from the Drive-era code):
    // if any upload after the first succeeded and a later one failed, clean
    // up everything already uploaded in this batch.
    await limpiarArchivosSubidos({ fotos: fotosSubidas, video: videoSubido });
    throw err;
  }

  return { fotosSubidas, videoSubido };
}

// --- Cloudinary storage migration: original Drive-uploading implementation, kept for reference ---
// async function subirArchivosNuevosDrive({ fotosNuevas, videoNuevo, parents }) {
//   const fotosSubidas = [];
//   let videoSubido = null;
//
//   try {
//     for (const foto of fotosNuevas) {
//       const { driveFileId, url } = await googleDrive.subirArchivo(foto.buffer, foto.mimetype, foto.originalname, {
//         makePublic: true,
//         parents,
//       });
//       fotosSubidas.push({ driveFileId, url });
//     }
//
//     if (videoNuevo) {
//       const { driveFileId, url } = await googleDrive.subirArchivo(
//         videoNuevo.buffer,
//         videoNuevo.mimetype,
//         videoNuevo.originalname,
//         { makePublic: false, parents },
//       );
//       videoSubido = { driveFileId, url };
//     }
//   } catch (err) {
//     await limpiarArchivosSubidos({ fotos: fotosSubidas, video: videoSubido });
//     throw err;
//   }
//
//   return { fotosSubidas, videoSubido };
// }

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

/** Best-effort Cloudinary cleanup — never throws, used in catch blocks. */
async function limpiarArchivosSubidos({ fotos = [], video = null }, req) {
  for (const foto of fotos) {
    try {
      await cloudinary.eliminarArchivo(foto.cloudinaryPublicId, foto.cloudinaryResourceType);
    } catch (err) {
      logFallaDeLimpieza(
        `No se pudo limpiar la foto huérfana en Cloudinary (${foto.cloudinaryPublicId})`,
        err,
        req,
      );
    }
  }
  if (video) {
    try {
      await cloudinary.eliminarArchivo(video.cloudinaryPublicId, video.cloudinaryResourceType);
    } catch (err) {
      logFallaDeLimpieza(
        `No se pudo limpiar el video huérfano en Cloudinary (${video.cloudinaryPublicId})`,
        err,
        req,
      );
    }
  }
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

    // Cloudinary storage migration: Drive per-product folder creation
    // removed here (see commented block below) — Cloudinary doesn't need a
    // separate "create folder" call like Drive did; passing `folder` at
    // upload time (see just below) creates it implicitly.
    // let driveFolderId = null;
    // if (fotosNuevas.length > 0 || videoArr.length > 0) {
    //   const carpeta = await googleDrive.crearCarpeta(
    //     `${producto.id}-${nombre.trim()}`,
    //     process.env.GOOGLE_DRIVE_FOLDER_ID,
    //   );
    //   driveFolderId = carpeta.driveFolderId;
    // }

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
    // Orphan prevention (design D6): clean up any Drive uploads from this
    // batch. The product DB row (if created) is intentionally NOT rolled
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

    // Cloudinary storage migration: Drive lazy-folder-creation removed here
    // (see commented block below) — new uploads on ANY product (new or
    // legacy Drive-backed) now go to Cloudinary instead, grouped into the
    // product's own Cloudinary folder (see the `folder` line just below —
    // same per-product grouping idea as Drive's old subfolder, different
    // storage backend). A legacy product's EXISTING Drive-hosted photos are
    // untouched either way — this only affects where a NEW upload lands.
    // let driveFolderId = existente.driveFolderId;
    // if (!driveFolderId && (fotosNuevas.length > 0 || videoArr.length > 0)) {
    //   const carpeta = await googleDrive.crearCarpeta(
    //     `${existente.id}-${(nombre ?? existente.nombre).trim()}`,
    //     process.env.GOOGLE_DRIVE_FOLDER_ID,
    //   );
    //   driveFolderId = carpeta.driveFolderId;
    // }
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
            // Cloudinary storage migration: driveFolderId no longer computed for new uploads.
            // driveFolderId: driveFolderId !== existente.driveFolderId ? driveFolderId : undefined,
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
      // Cloudinary storage migration: driveFolderId no longer computed here, nothing to clean up.
      // if (driveFolderId && driveFolderId !== existente.driveFolderId) {
      //   await googleDrive.eliminarArchivo(driveFolderId).catch((err) => console.error("Cleanup carpeta:", err));
      // }
      throw dbErr;
    }

    // DB writes succeeded — now clean up whichever storage backend each
    // removed photo/video actually used (existing rows may be Drive- or
    // Cloudinary-backed; a row has exactly one of the two ids set).
    for (const foto of fotosARemover) {
      if (foto.driveFileId) {
        await googleDrive
          .eliminarArchivo(foto.driveFileId)
          .catch((err) => logFallaDeLimpieza("No se pudo eliminar la foto en Drive", err, req));
      } else if (foto.cloudinaryPublicId) {
        await cloudinary
          .eliminarArchivo(foto.cloudinaryPublicId, foto.cloudinaryResourceType)
          .catch((err) => logFallaDeLimpieza("No se pudo eliminar la foto en Cloudinary", err, req));
      }
    }
    if (videoSubido && existente.video) {
      if (existente.video.driveFileId) {
        await googleDrive
          .eliminarArchivo(existente.video.driveFileId)
          .catch((err) => logFallaDeLimpieza("No se pudo eliminar el video anterior en Drive", err, req));
      } else if (existente.video.cloudinaryPublicId) {
        await cloudinary
          .eliminarArchivo(existente.video.cloudinaryPublicId, existente.video.cloudinaryResourceType)
          .catch((err) => logFallaDeLimpieza("No se pudo eliminar el video anterior en Cloudinary", err, req));
      }
    } else if (eliminarVideo && existente.video) {
      if (existente.video.driveFileId) {
        await googleDrive
          .eliminarArchivo(existente.video.driveFileId)
          .catch((err) => logFallaDeLimpieza("No se pudo eliminar el video en Drive", err, req));
      } else if (existente.video.cloudinaryPublicId) {
        await cloudinary
          .eliminarArchivo(existente.video.cloudinaryPublicId, existente.video.cloudinaryResourceType)
          .catch((err) => logFallaDeLimpieza("No se pudo eliminar el video en Cloudinary", err, req));
      }
    }

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
    for (const foto of producto.fotos) {
      if (foto.driveFileId) {
        await googleDrive
          .eliminarArchivo(foto.driveFileId)
          .catch((err) => logFallaDeLimpieza("No se pudo eliminar la foto en Drive", err, req));
      } else if (foto.cloudinaryPublicId) {
        await cloudinary
          .eliminarArchivo(foto.cloudinaryPublicId, foto.cloudinaryResourceType)
          .catch((err) => logFallaDeLimpieza("No se pudo eliminar la foto en Cloudinary", err, req));
      }
    }
    if (producto.video) {
      if (producto.video.driveFileId) {
        await googleDrive
          .eliminarArchivo(producto.video.driveFileId)
          .catch((err) => logFallaDeLimpieza("No se pudo eliminar el video en Drive", err, req));
      } else if (producto.video.cloudinaryPublicId) {
        await cloudinary
          .eliminarArchivo(producto.video.cloudinaryPublicId, producto.video.cloudinaryResourceType)
          .catch((err) => logFallaDeLimpieza("No se pudo eliminar el video en Cloudinary", err, req));
      }
    }
    // Then remove the (now-empty, or never-used) per-product Drive folder
    // itself, if one exists (only ever set for legacy Drive-era products —
    // Cloudinary uploads never create one).
    if (producto.driveFolderId) {
      await googleDrive
        .eliminarArchivo(producto.driveFolderId)
        .catch((err) => logFallaDeLimpieza("No se pudo eliminar la carpeta del producto en Drive", err, req));
    }
    // Same idea for the Cloudinary side: remove the per-product folder now
    // that every asset inside it was just deleted above. Uses the same
    // folder name formula as crear/actualizar so it matches regardless of
    // when the product's media was last uploaded.
    const carpetaCloudinary = `productos/${producto.id}-${sanitizarNombreParaCarpeta(producto.nombre.trim())}`;
    await cloudinary
      .eliminarCarpeta(carpetaCloudinary)
      .catch((err) => logFallaDeLimpieza("No se pudo eliminar la carpeta del producto en Cloudinary", err, req));

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

    if (foto.driveFileId) {
      await googleDrive
        .eliminarArchivo(foto.driveFileId)
        .catch((err) => logFallaDeLimpieza("No se pudo eliminar la foto en Drive", err, req));
    } else if (foto.cloudinaryPublicId) {
      await cloudinary
        .eliminarArchivo(foto.cloudinaryPublicId, foto.cloudinaryResourceType)
        .catch((err) => logFallaDeLimpieza("No se pudo eliminar la foto en Cloudinary", err, req));
    }

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
