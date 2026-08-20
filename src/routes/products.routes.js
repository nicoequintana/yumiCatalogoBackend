import { Router } from "express";
import multer from "multer";
import * as productsController from "../controllers/products.controller.js";
import * as productsMediaController from "../controllers/productsMedia.controller.js";
import * as productsImportController from "../controllers/productsImport.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";
import { MAX_FOTOS } from "../lib/limitesMedios.js";

const ALLOWED_PHOTO_MIMES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_VIDEO_MIMES = ["video/mp4", "video/webm"];

// Global multer limit is the video ceiling (design: ~100MB video / ~15MB
// photo). Multer can't apply a different fileSize per field, so the
// per-field 15MB photo cap is enforced manually in the controller.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.fieldname === "fotos") {
      if (!ALLOWED_PHOTO_MIMES.includes(file.mimetype)) {
        return cb(new Error("Tipo de imagen no permitido. Use JPEG, PNG o WEBP."));
      }
      return cb(null, true);
    }
    if (file.fieldname === "video") {
      if (!ALLOWED_VIDEO_MIMES.includes(file.mimetype)) {
        return cb(new Error("Tipo de video no permitido. Use MP4 o WEBM."));
      }
      return cb(null, true);
    }
    cb(new Error("Campo de archivo inesperado."));
  },
});

const uploadFields = upload.fields([
  { name: "fotos", maxCount: MAX_FOTOS },
  { name: "video", maxCount: 1 },
]);

const MIMES_XLSX = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/octet-stream", // algunos browsers mandan esto para .xlsx
];

// Multer propio para el import: un solo archivo, tope chico (una planilla de
// texto no pesa nada) y filtro por extensión además de MIME, porque el MIME
// que manda el browser para .xlsx no es confiable.
const uploadXlsx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const esXlsx = file.originalname.toLowerCase().endsWith(".xlsx");
    if (!esXlsx || !MIMES_XLSX.includes(file.mimetype)) {
      // `status` explícito: el error handler central de `server.js` reemplaza
      // el mensaje por "Error interno del servidor." en cualquier error sin
      // status (status 500). Un archivo con la extensión equivocada es un
      // error del usuario, no una falla del servidor — tiene que llegarle el
      // mensaje que le dice cómo arreglarlo.
      const err = new Error("El archivo debe ser un .xlsx. Descargá la plantilla y completala.");
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
}).single("archivo");

// `POST /:id/compartir` y `POST /:id/favorito` son públicos, sin auth, y
// además de insertar en `EventoTrafico` incrementan contadores persistidos en
// `Product` (`compartidos` / `favoritosCount`). Sin limitador, cualquiera
// puede inflar esas métricas y ensuciar las pantallas de analytics del admin.
//
// Ambas comparten un mismo bucket: son las dos interacciones públicas de
// producto y no tiene sentido presupuestarlas por separado. 100 cada 5
// minutos por IP es holgado para una persona real (compartir y marcar
// favoritos son clicks deliberados; recorrer la colección entera marcando
// corazones no llega ni cerca) y sigue siendo mucho más laxo que login u
// órdenes, donde el riesgo es takeover de cuenta o spam de pedidos.
const limitadorInteraccionesPublicas = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 100,
  message: "Demasiadas interacciones seguidas. Probá de nuevo en unos minutos.",
});

const router = Router();

router.get("/", productsController.listar);
router.get("/import/template", requireAuth, productsImportController.descargarPlantilla);
router.get("/:id/video", productsMediaController.streamVideo);
router.get("/:id/fotos/:fotoId", productsMediaController.streamFoto);
router.get("/:id", productsController.obtenerPorId);
router.post("/import", requireAuth, uploadXlsx, productsImportController.importar);
router.post("/", requireAuth, uploadFields, productsController.crear);
router.post("/:id/compartir", limitadorInteraccionesPublicas, productsController.compartir);
router.post("/:id/favorito", limitadorInteraccionesPublicas, productsController.favorito);
router.put("/:id", requireAuth, uploadFields, productsController.actualizar);
router.patch("/:id/visibilidad", requireAuth, productsController.actualizarVisibilidad);
router.patch("/:id/merchandising", requireAuth, productsController.actualizarMerchandising);
router.delete("/:id", requireAuth, productsController.eliminar);
router.delete("/:id/fotos/:fotoId", requireAuth, productsController.eliminarFoto);

export default router;
