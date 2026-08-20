/**
 * Proxy de streaming de la media legada alojada en Google Drive.
 *
 * Solo aplica a las filas anteriores a la migración a Cloudinary (las que
 * tienen `driveFileId`): la media subida a Cloudinary se sirve por su propia
 * URL y nunca pasa por acá. Se separó del controller principal porque no
 * comparte nada con el CRUD de producto salvo la tabla — no usa el mapper, ni
 * los parsers, ni la auditoría.
 */

import { prisma } from "../lib/prisma.js";
import * as googleDrive from "../services/googleDrive.service.js";
import { logError } from "../lib/logError.js";
import { httpError } from "../lib/httpError.js";
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
