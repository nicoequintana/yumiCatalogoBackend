import { prisma } from "../lib/prisma.js";
import * as googleDrive from "../services/googleDrive.service.js";
import * as cloudinary from "../services/cloudinary.service.js";
import { generarSku } from "../lib/sku.js";
import { logError } from "../lib/logError.js";

const MAX_FOTOS = 10;
const MAX_FOTO_BYTES = 15 * 1024 * 1024; // 15MB per-field cap (design: multer's global limit can't differ per field)

const DISPONIBILIDAD_VALIDA = ["DISPONIBLE", "AGOTADO", "A_PEDIDO"];

const PRODUCT_INCLUDE = {
  caracteristicas: true,
  fotos: { orderBy: { orden: "asc" } },
  video: true,
  categoria: true,
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
    visibleEnCatalogo: producto.visibleEnCatalogo,
    disponibilidad: producto.disponibilidad,
    destacado: producto.destacado,
    orden: producto.orden,
    caracteristicas: producto.caracteristicas.map((c) => ({ id: c.id, texto: c.texto })),
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
 * (`disponibilidad`, `destacado`, `orden`). Follows the same `esCreacion`
 * pattern as `validarCamposBase`: a field is only validated/applied when the
 * caller explicitly sent it — omitting it on update leaves the existing
 * value untouched, and on create it just falls back to its DB default.
 * Returns the normalized values (booleans/numbers coerced from the raw
 * strings multipart/form-data sends) for the caller to use in the Prisma
 * write.
 */
function validarCamposMerchandising({ disponibilidad, destacado, orden }) {
  if (disponibilidad !== undefined && !DISPONIBILIDAD_VALIDA.includes(disponibilidad)) {
    throw httpError(400, "disponibilidad debe ser DISPONIBLE, AGOTADO o A_PEDIDO.");
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

  return { disponibilidad, destacado: destacadoNormalizado, orden: ordenNormalizado };
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

/** Best-effort Cloudinary cleanup — never throws, used in catch blocks. */
async function limpiarArchivosSubidos({ fotos = [], video = null }) {
  for (const foto of fotos) {
    try {
      await cloudinary.eliminarArchivo(foto.cloudinaryPublicId, foto.cloudinaryResourceType);
    } catch (err) {
      console.error("No se pudo limpiar la foto huérfana en Cloudinary:", foto.cloudinaryPublicId, err);
    }
  }
  if (video) {
    try {
      await cloudinary.eliminarArchivo(video.cloudinaryPublicId, video.cloudinaryResourceType);
    } catch (err) {
      console.error("No se pudo limpiar el video huérfano en Cloudinary:", video.cloudinaryPublicId, err);
    }
  }
}

export async function listar(req, res, next) {
  try {
    const esAdmin = req.query.admin !== undefined;

    const productos = await prisma.product.findMany({
      where: esAdmin ? undefined : { visibleEnCatalogo: true },
      include: PRODUCT_INCLUDE,
      orderBy: [{ orden: "asc" }, { createdAt: "desc" }],
    });
    res.json(productos.map(mapProducto));
  } catch (err) {
    next(err);
  }
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
    }

    res.json(mapProducto(producto));
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

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  let subidas = null;
  let producto = null;
  try {
    const { nombre, descripcion, precio, etiqueta, categoriaId, disponibilidad, destacado, orden } = req.body;
    validarCamposBase({ nombre, descripcion, precio }, { esCreacion: true });
    const merchandising = validarCamposMerchandising({ disponibilidad, destacado, orden });

    const caracteristicas = parseCaracteristicas(req.body.caracteristicas) ?? [];
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
            disponibilidad: merchandising.disponibilidad ?? "DISPONIBLE",
            destacado: merchandising.destacado ?? false,
            orden: merchandising.orden ?? 0,
            caracteristicas: { create: caracteristicas },
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

    res.status(201).json(mapProducto(producto));
  } catch (err) {
    // Orphan prevention (design D6): clean up any Drive uploads from this
    // batch. The product DB row (if created) is intentionally NOT rolled
    // back — per design item 1, a partially-created product (no media) is
    // an accepted state the admin can fix by editing.
    if (subidas) await limpiarArchivosSubidos({ fotos: subidas.fotosSubidas, video: subidas.videoSubido });
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const existente = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const { nombre, descripcion, precio, etiqueta, categoriaId, disponibilidad, destacado, orden } = req.body;
    validarCamposBase({ nombre, descripcion, precio }, { esCreacion: false });
    const merchandising = validarCamposMerchandising({ disponibilidad, destacado, orden });

    const caracteristicas = parseCaracteristicas(req.body.caracteristicas);
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
            disponibilidad: merchandising.disponibilidad,
            destacado: merchandising.destacado,
            orden: merchandising.orden,
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
      await limpiarArchivosSubidos({ fotos: fotosSubidas, video: videoSubido });
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
        await googleDrive.eliminarArchivo(foto.driveFileId).catch((err) => console.error(err));
      } else if (foto.cloudinaryPublicId) {
        await cloudinary
          .eliminarArchivo(foto.cloudinaryPublicId, foto.cloudinaryResourceType)
          .catch((err) => console.error(err));
      }
    }
    if (videoSubido && existente.video) {
      if (existente.video.driveFileId) {
        await googleDrive.eliminarArchivo(existente.video.driveFileId).catch((err) => console.error(err));
      } else if (existente.video.cloudinaryPublicId) {
        await cloudinary
          .eliminarArchivo(existente.video.cloudinaryPublicId, existente.video.cloudinaryResourceType)
          .catch((err) => console.error(err));
      }
    } else if (eliminarVideo && existente.video) {
      if (existente.video.driveFileId) {
        await googleDrive.eliminarArchivo(existente.video.driveFileId).catch((err) => console.error(err));
      } else if (existente.video.cloudinaryPublicId) {
        await cloudinary
          .eliminarArchivo(existente.video.cloudinaryPublicId, existente.video.cloudinaryResourceType)
          .catch((err) => console.error(err));
      }
    }

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

    // Always sweep individual files first — a product may have a
    // driveFolderId AND still have some fotos/video whose driveFileId
    // predates that folder (e.g. a legacy product that was edited once
    // after this feature shipped: the new upload went into a fresh
    // subfolder, but its original photos are still in the flat root
    // folder). Deleting the folder alone would leave those orphaned.
    for (const foto of producto.fotos) {
      if (foto.driveFileId) {
        await googleDrive.eliminarArchivo(foto.driveFileId).catch((err) => console.error("Cleanup foto:", err));
      } else if (foto.cloudinaryPublicId) {
        await cloudinary
          .eliminarArchivo(foto.cloudinaryPublicId, foto.cloudinaryResourceType)
          .catch((err) => console.error("Cleanup foto:", err));
      }
    }
    if (producto.video) {
      if (producto.video.driveFileId) {
        await googleDrive.eliminarArchivo(producto.video.driveFileId).catch((err) => console.error("Cleanup video:", err));
      } else if (producto.video.cloudinaryPublicId) {
        await cloudinary
          .eliminarArchivo(producto.video.cloudinaryPublicId, producto.video.cloudinaryResourceType)
          .catch((err) => console.error("Cleanup video:", err));
      }
    }
    // Then remove the (now-empty, or never-used) per-product Drive folder
    // itself, if one exists (only ever set for legacy Drive-era products —
    // Cloudinary uploads never create one).
    if (producto.driveFolderId) {
      await googleDrive.eliminarArchivo(producto.driveFolderId).catch((err) => console.error("Cleanup carpeta:", err));
    }
    // Same idea for the Cloudinary side: remove the per-product folder now
    // that every asset inside it was just deleted above. Uses the same
    // folder name formula as crear/actualizar so it matches regardless of
    // when the product's media was last uploaded.
    const carpetaCloudinary = `productos/${producto.id}-${sanitizarNombreParaCarpeta(producto.nombre.trim())}`;
    await cloudinary.eliminarCarpeta(carpetaCloudinary).catch((err) => console.error("Cleanup carpeta Cloudinary:", err));

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
      await googleDrive.eliminarArchivo(foto.driveFileId).catch((err) => console.error("Cleanup foto:", err));
    } else if (foto.cloudinaryPublicId) {
      await cloudinary
        .eliminarArchivo(foto.cloudinaryPublicId, foto.cloudinaryResourceType)
        .catch((err) => console.error("Cleanup foto:", err));
    }

    const productoActualizado = await prisma.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
    res.json(mapProducto(productoActualizado));
  } catch (err) {
    next(err);
  }
}
