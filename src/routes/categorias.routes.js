import { Router } from "express";
import multer from "multer";
import * as categoriasController from "../controllers/categorias.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { requierePermisoDeBorrado } from "../middlewares/permisoBorrado.middleware.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";
import { MAX_FOTO_BYTES, ALLOWED_PHOTO_MIMES } from "../lib/limitesMedios.js";

const router = Router();

/**
 * Uploader de la imagen de categoría. Un solo archivo, sólo imágenes, mismo
 * tope de tamaño que una foto de producto.
 *
 * El `fileSize` puede vivir acá (a diferencia del alta de producto, que lo
 * valida a mano): este uploader no maneja videos, así que no tiene el
 * conflicto del `fileSize` único por instancia de multer.
 */
const uploadImagen = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FOTO_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_PHOTO_MIMES.includes(file.mimetype)) {
      // `status` explícito, mismo motivo que en `products.routes.js`: sin él el
      // error handler central lo trata como interno y el admin ve un 500 en
      // lugar del mensaje que le dice qué formatos sirven.
      const err = new Error("Formato de imagen no permitido. Se aceptan JPG, PNG y WEBP.");
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

// Techo de lectura pública (600/5min por IP), mismo criterio que los GET
// públicos de producto: este listado no tenía ningún límite y pega a la base
// en cada carga de `/coleccion` y de la home. 600 es holgadísimo para
// navegación humana real y corta el flood/scraping.
const limitadorLecturaPublica = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: "Demasiadas solicitudes seguidas. Probá de nuevo en unos minutos.",
});

// GET es PÚBLICO a propósito: el listado de categorías alimenta los filtros
// de la página pública `/coleccion` (`Coleccion.jsx`) y la sección "Explorá
// por categoría" de la home, las dos navegables sin login. Todas las rutas de
// escritura son operaciones del panel admin y van protegidas.
router.get("/", limitadorLecturaPublica, categoriasController.listar);
router.post("/", requireAuth, categoriasController.crear);

router.put("/:id", requireAuth, categoriasController.actualizar);
router.patch("/:id/home", requireAuth, categoriasController.actualizarDestacada);
router.put(
  "/:id/imagen",
  requireAuth,
  uploadImagen.single("imagen"),
  categoriasController.guardarImagen,
);
router.delete("/:id/imagen", requireAuth, categoriasController.quitarImagen);
router.delete("/:id", requireAuth, requierePermisoDeBorrado, categoriasController.eliminar);

export default router;
