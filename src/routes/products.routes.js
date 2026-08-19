import { Router } from "express";
import multer from "multer";
import * as productsController from "../controllers/products.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

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
  { name: "fotos", maxCount: 10 },
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

const router = Router();

router.get("/", productsController.listar);
router.get("/import/template", requireAuth, productsController.descargarPlantilla);
router.get("/:id/video", productsController.streamVideo);
router.get("/:id/fotos/:fotoId", productsController.streamFoto);
router.get("/:id", productsController.obtenerPorId);
router.post("/import", requireAuth, uploadXlsx, productsController.importar);
router.post("/", requireAuth, uploadFields, productsController.crear);
router.post("/:id/compartir", productsController.compartir);
router.post("/:id/favorito", productsController.favorito);
router.put("/:id", requireAuth, uploadFields, productsController.actualizar);
router.patch("/:id/visibilidad", requireAuth, productsController.actualizarVisibilidad);
router.patch("/:id/merchandising", requireAuth, productsController.actualizarMerchandising);
router.delete("/:id", requireAuth, productsController.eliminar);
router.delete("/:id/fotos/:fotoId", requireAuth, productsController.eliminarFoto);

export default router;
