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

const router = Router();

router.get("/", productsController.listar);
router.get("/:id/video", productsController.streamVideo);
router.get("/:id/fotos/:fotoId", productsController.streamFoto);
router.get("/:id", productsController.obtenerPorId);
router.post("/", requireAuth, uploadFields, productsController.crear);
router.post("/:id/compartir", requireAuth, productsController.compartir);
router.put("/:id", requireAuth, uploadFields, productsController.actualizar);
router.patch("/:id/visibilidad", requireAuth, productsController.actualizarVisibilidad);
router.delete("/:id", requireAuth, productsController.eliminar);
router.delete("/:id/fotos/:fotoId", requireAuth, productsController.eliminarFoto);

export default router;
