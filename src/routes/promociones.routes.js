import { Router } from "express";
import multer from "multer";
import * as promocionesController from "../controllers/promociones.controller.js";
import * as eventosComercialesController from "../controllers/eventosComerciales.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { requierePermisoDeBorrado } from "../middlewares/permisoBorrado.middleware.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";
import { ALLOWED_PHOTO_MIMES, MAX_FOTO_BYTES } from "../lib/limitesMedios.js";

const router = Router();

// Ver el comentario gemelo en campanias.routes.js: mismo techo, mismo motivo.
const limitadorEventosComerciales = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: "Demasiadas solicitudes. Probá de nuevo en unos minutos.",
});

// Instancia propia (y no compartida con campañas) para que el campo multipart
// que espera —"arte"— quede en el nombre de la variable y no en un parámetro
// que hay que ir a buscar. Mismo criterio que `uploadArte` de campanias.routes.
const uploadArte = multer({
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

/**
 * ADMIN → Promociones. **Todo el módulo exige auth, con UNA excepción**:
 * `POST /:id/evento`, que registra impresiones y clicks del slide de una
 * promoción y la emite el navegador de cualquier visitante (07/09/2026).
 * Es la única ruta pública acá, lleva su propio limitador, y NO expone nada:
 * escribe un evento y responde `{ id }`. Las lecturas siguen todas detrás de
 * `requireAuth` — los descuentos que el catálogo necesita ya viajan resueltos
 * en `GET /products`, así que un endpoint público de lectura solo agregaría
 * superficie, y una de las peores, porque expone costo y coeficiente.
 *
 * ⚠️ `/productos` va ANTES de `/:id`: si no, Express matchea "productos" como
 * un id. Mismo pisotón que evitan `/products/import` y `/campanias/activas`.
 */
router.get("/productos", requireAuth, promocionesController.listadoComercial);
// Solo lectura: los conflictos se calculan cada vez, no se guardan. Un snapshot
// habría que invalidarlo ante cualquier cambio de items, de programación o de
// estado de campaña — y el §41 pide que agregar un producto a una promoción ya
// programada haga aparecer el conflicto nuevo.
router.get("/conflictos", requireAuth, promocionesController.listarConflictos);

// PROGRAMACIONES. Viven bajo `/promociones` porque una programación no existe
// sin su promoción, pero la ACCIÓN de programar es del calendario: esta
// pantalla no las llama, las llama `AdminCampanias`.
//
// ⚠️ Las tres van antes de `/:id`: "programaciones" no puede matchearse como
// un id de promoción.
router.get("/programaciones", requireAuth, promocionesController.listarProgramaciones);
router.patch("/programaciones/:programacionId", requireAuth, promocionesController.cambiarEstadoProgramacion);
router.delete("/programaciones/:programacionId", requireAuth, promocionesController.eliminarProgramacion);
router.post("/:id/programaciones", requireAuth, promocionesController.crearProgramacion);

router.get("/", requireAuth, promocionesController.listar);
router.post("/", requireAuth, promocionesController.crear);

// También antes de `/:id`, por lo mismo.
router.put("/:id/items", requireAuth, promocionesController.guardarItems);
router.patch("/:id/items/:productId", requireAuth, promocionesController.cambiarEstadoItem);

// Pública, con limitador propio: ver el docblock del archivo.
router.post("/:id/evento", limitadorEventosComerciales, eventosComercialesController.crearDePromocion);

// La pieza apaisada del slide: mismo patrón multipart que el Doodle/arte de
// campañas. Ruta y campo propios porque `PUT /:id` sigue siendo JSON puro.
router.put("/:id/arte", requireAuth, uploadArte.single("arte"), promocionesController.guardarArte);
router.delete("/:id/arte", requireAuth, promocionesController.quitarArte);

router.get("/:id", requireAuth, promocionesController.obtenerPorId);
router.put("/:id", requireAuth, promocionesController.actualizar);
router.delete("/:id", requireAuth, requierePermisoDeBorrado, promocionesController.eliminar);

export default router;
