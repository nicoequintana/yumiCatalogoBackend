import { Router } from "express";
import multer from "multer";
import * as combosController from "../controllers/combos.controller.js";
import { requireAuth, authOpcional } from "../middlewares/auth.middleware.js";
import { requierePermisoDeBorrado } from "../middlewares/permisoBorrado.middleware.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";
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
router.post("/admin/combos/cotizar", requireAuth, combosController.cotizar);
router.get("/admin/combos/:id", requireAuth, combosController.obtenerAdminPorId);
router.put("/admin/combos/:id", requireAuth, combosController.actualizar);
router.delete("/admin/combos/:id", requireAuth, requierePermisoDeBorrado, combosController.eliminar);

// El hero: mismo patrón multipart que el arte de promociones.
router.put("/admin/combos/:id/hero", requireAuth, uploadHero.single("hero"), combosController.guardarHero);
router.delete("/admin/combos/:id/hero", requireAuth, combosController.quitarHero);

// Mismo limitador de lectura pública que `campanias.routes.js`/`anuncios.routes.js`.
const limitadorLecturaPublica = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: "Demasiadas solicitudes seguidas. Probá de nuevo en unos minutos.",
});

router.get("/", limitadorLecturaPublica, authOpcional, combosController.listarPublico);
router.get("/opciones", limitadorLecturaPublica, authOpcional, combosController.opciones);
router.get("/:idSlug", limitadorLecturaPublica, authOpcional, combosController.obtenerPublico);

export default router;
