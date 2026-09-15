import { Router } from "express";
import multer from "multer";
import * as combosController from "../controllers/combos.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { requierePermisoDeBorrado } from "../middlewares/permisoBorrado.middleware.js";
import { ALLOWED_PHOTO_MIMES, MAX_FOTO_BYTES } from "../lib/limitesMedios.js";

const router = Router();

// Instancia propia, mismo criterio que `uploadArte` de promociones.routes.js:
// el campo multipart ("hero") queda en el nombre de la variable.
const uploadHero = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FOTO_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_PHOTO_MIMES.includes(file.mimetype)) {
      const err = new Error("Formato de imagen no permitido. Se aceptan JPG, PNG y WEBP.");
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

router.get("/admin/combos", requireAuth, combosController.listarAdmin);
router.post("/admin/combos", requireAuth, combosController.crear);
router.get("/admin/combos/:id", requireAuth, combosController.obtenerAdminPorId);
router.put("/admin/combos/:id", requireAuth, combosController.actualizar);
router.delete("/admin/combos/:id", requireAuth, requierePermisoDeBorrado, combosController.eliminar);

// El hero: mismo patrón multipart que el arte de promociones.
router.put("/admin/combos/:id/hero", requireAuth, uploadHero.single("hero"), combosController.guardarHero);
router.delete("/admin/combos/:id/hero", requireAuth, combosController.quitarHero);

export default router;
