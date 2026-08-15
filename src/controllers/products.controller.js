import { prisma } from "../lib/prisma.js";
import * as googleDrive from "../services/googleDrive.service.js";

const MAX_FOTOS = 10;
const MAX_FOTO_BYTES = 15 * 1024 * 1024; // 15MB per-field cap (design: multer's global limit can't differ per field)

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
    nombre: producto.nombre,
    descripcion: producto.descripcion,
    precio: producto.precio.toString(),
    etiqueta: producto.etiqueta,
    categoria: producto.categoria ? { id: producto.categoria.id, nombre: producto.categoria.nombre } : null,
    caracteristicas: producto.caracteristicas.map((c) => ({ id: c.id, texto: c.texto })),
    fotos: producto.fotos.map((f) => ({
      id: f.id,
      url: f.driveFileId ? `/api/products/${producto.id}/fotos/${f.id}` : f.url,
      driveFileId: f.driveFileId,
      orden: f.orden,
    })),
    video: producto.video
      ? { id: producto.video.id, url: `/api/products/${producto.id}/video`, driveFileId: producto.video.driveFileId }
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

/** Uploads new photos + optional video to Drive. Returns their Drive metadata for DB writes. */
async function subirArchivosNuevos({ fotosNuevas, videoNuevo, parents }) {
  const fotosSubidas = [];
  let videoSubido = null;

  try {
    for (const foto of fotosNuevas) {
      const { driveFileId, url } = await googleDrive.subirArchivo(foto.buffer, foto.mimetype, foto.originalname, {
        makePublic: true,
        parents,
      });
      fotosSubidas.push({ driveFileId, url });
    }

    if (videoNuevo) {
      const { driveFileId, url } = await googleDrive.subirArchivo(
        videoNuevo.buffer,
        videoNuevo.mimetype,
        videoNuevo.originalname,
        { makePublic: false, parents },
      );
      videoSubido = { driveFileId, url };
    }
  } catch (err) {
    // Orphan prevention (design D6): if any upload after the first succeeded
    // and a later one failed, clean up everything already uploaded in this batch.
    await limpiarArchivosSubidos({ fotos: fotosSubidas, video: videoSubido });
    throw err;
  }

  return { fotosSubidas, videoSubido };
}

/** Best-effort Drive cleanup — never throws, used in catch blocks. */
async function limpiarArchivosSubidos({ fotos = [], video = null }) {
  for (const foto of fotos) {
    try {
      await googleDrive.eliminarArchivo(foto.driveFileId);
    } catch (err) {
      console.error("No se pudo limpiar la foto huérfana en Drive:", foto.driveFileId, err);
    }
  }
  if (video) {
    try {
      await googleDrive.eliminarArchivo(video.driveFileId);
    } catch (err) {
      console.error("No se pudo limpiar el video huérfano en Drive:", video.driveFileId, err);
    }
  }
}

export async function listar(_req, res, next) {
  try {
    const productos = await prisma.product.findMany({
      include: PRODUCT_INCLUDE,
      orderBy: { createdAt: "desc" },
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

    const producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!producto) throw httpError(404, "Producto no encontrado.");

    res.json(mapProducto(producto));
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  let subidas = null;
  let producto = null;
  try {
    const { nombre, descripcion, precio, etiqueta, categoriaId } = req.body;
    validarCamposBase({ nombre, descripcion, precio }, { esCreacion: true });

    const caracteristicas = parseCaracteristicas(req.body.caracteristicas) ?? [];
    const fotosNuevas = req.files?.fotos ?? [];
    const videoArr = req.files?.video ?? [];

    validarArchivos({ fotosNuevas, fotosExistentesCount: 0, video: videoArr });

    // Create the DB row first (no media yet) so we have a real id to name
    // the product's Drive subfolder with (design item 1's ordering fix).
    producto = await prisma.product.create({
      data: {
        nombre: nombre.trim(),
        descripcion: descripcion.trim(),
        precio: String(precio),
        etiqueta: etiqueta?.trim() || null,
        categoriaId: categoriaId ? Number(categoriaId) : null,
        caracteristicas: { create: caracteristicas },
      },
      include: PRODUCT_INCLUDE,
    });

    let driveFolderId = null;
    if (fotosNuevas.length > 0 || videoArr.length > 0) {
      const carpeta = await googleDrive.crearCarpeta(
        `${producto.id}-${nombre.trim()}`,
        process.env.GOOGLE_DRIVE_FOLDER_ID,
      );
      driveFolderId = carpeta.driveFolderId;
    }

    subidas = await subirArchivosNuevos({ fotosNuevas, videoNuevo: videoArr[0] ?? null, parents: driveFolderId ? [driveFolderId] : undefined });
    const { fotosSubidas, videoSubido } = subidas;

    producto = await prisma.product.update({
      where: { id: producto.id },
      data: {
        driveFolderId,
        fotos: {
          create: fotosSubidas.map((f, index) => ({ url: f.url, driveFileId: f.driveFileId, orden: index })),
        },
        video: videoSubido ? { create: { url: videoSubido.url, driveFileId: videoSubido.driveFileId } } : undefined,
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

    const { nombre, descripcion, precio, etiqueta, categoriaId } = req.body;
    validarCamposBase({ nombre, descripcion, precio }, { esCreacion: false });

    const caracteristicas = parseCaracteristicas(req.body.caracteristicas);
    const fotosExistentesIds = parseFotosExistentes(req.body.fotosExistentes) ?? existente.fotos.map((f) => f.id);
    const fotosNuevas = req.files?.fotos ?? [];
    const videoArr = req.files?.video ?? [];
    const eliminarVideo = req.body.eliminarVideo === "true";

    validarArchivos({ fotosNuevas, fotosExistentesCount: fotosExistentesIds.length, video: videoArr });

    // Photos removed by the client (present before, absent from fotosExistentes) get deleted from Drive too.
    const fotosARemover = existente.fotos.filter((f) => !fotosExistentesIds.includes(f.id));

    let driveFolderId = existente.driveFolderId;
    if (!driveFolderId && (fotosNuevas.length > 0 || videoArr.length > 0)) {
      const carpeta = await googleDrive.crearCarpeta(
        `${existente.id}-${(nombre ?? existente.nombre).trim()}`,
        process.env.GOOGLE_DRIVE_FOLDER_ID,
      );
      driveFolderId = carpeta.driveFolderId;
    }

    const subidas = await subirArchivosNuevos({
      fotosNuevas,
      videoNuevo: videoArr[0] ?? null,
      parents: driveFolderId ? [driveFolderId] : undefined,
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
            driveFolderId: driveFolderId !== existente.driveFolderId ? driveFolderId : undefined,
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
              driveFileId: f.driveFileId,
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
              data: { url: videoSubido.url, driveFileId: videoSubido.driveFileId },
            });
          } else {
            await tx.video.create({
              data: { url: videoSubido.url, driveFileId: videoSubido.driveFileId, productId: id },
            });
          }
        } else if (eliminarVideo && existente.video) {
          await tx.video.delete({ where: { productId: id } });
        }

        return tx.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
      });
    } catch (dbErr) {
      // Orphan prevention (design D6): DB write failed after successful Drive upload(s).
      await limpiarArchivosSubidos({ fotos: fotosSubidas, video: videoSubido });
      if (driveFolderId && driveFolderId !== existente.driveFolderId) {
        await googleDrive.eliminarArchivo(driveFolderId).catch((err) => console.error("Cleanup carpeta:", err));
      }
      throw dbErr;
    }

    // DB writes succeeded — now clean up Drive files for photos/video the client actually removed.
    for (const foto of fotosARemover) {
      if (foto.driveFileId) await googleDrive.eliminarArchivo(foto.driveFileId).catch((err) => console.error(err));
    }
    if (eliminarVideo && existente.video?.driveFileId) {
      await googleDrive.eliminarArchivo(existente.video.driveFileId).catch((err) => console.error(err));
    }
    if (videoSubido && existente.video?.driveFileId) {
      await googleDrive.eliminarArchivo(existente.video.driveFileId).catch((err) => console.error(err));
    }

    res.json(mapProducto(productoActualizado));
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
      }
    }
    if (producto.video?.driveFileId) {
      await googleDrive.eliminarArchivo(producto.video.driveFileId).catch((err) => console.error("Cleanup video:", err));
    }
    // Then remove the (now-empty, or never-used) per-product folder itself,
    // if one exists.
    if (producto.driveFolderId) {
      await googleDrive.eliminarArchivo(producto.driveFolderId).catch((err) => console.error("Cleanup carpeta:", err));
    }

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
      console.error("Error al transmitir el video desde Drive:", streamErr);
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
      console.error("Error al transmitir la foto desde Drive:", streamErr);
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
    }

    const productoActualizado = await prisma.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
    res.json(mapProducto(productoActualizado));
  } catch (err) {
    next(err);
  }
}
