import { Router } from "express";
import multer from "multer";
import * as campaniasController from "../controllers/campanias.controller.js";
import { requireAuth, authOpcional } from "../middlewares/auth.middleware.js";
import { requierePermisoDeBorrado } from "../middlewares/permisoBorrado.middleware.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";
import { ALLOWED_PHOTO_MIMES, MAX_FOTO_BYTES } from "../lib/limitesMedios.js";

const router = Router();

// Un solo archivo en memoria antes de subirlo a Cloudinary, igual que la imagen
// de categoría. El `fileSize` puede vivir acá (a diferencia de los medios de
// producto) porque esta instancia no comparte upload con un video.
const uploadDoodle = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FOTO_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_PHOTO_MIMES.includes(file.mimetype)) {
      // El `status` explícito es lo que hace que un formato rechazado salga como
      // 400 y no como el 500 opaco en que el error handler convierte un
      // MulterError sin clasificar.
      const err = new Error("Formato de imagen no permitido. Se aceptan JPG, PNG y WEBP.");
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

// Mismo techo que la cinta de anuncios (600/5min por IP) y por el mismo motivo:
// el catálogo pide esto en cada carga de página, sin login y pegándole a la
// base. 600 es holgadísimo para navegación humana y corta el flood.
const limitadorLecturaPublica = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: "Demasiadas solicitudes seguidas. Probá de nuevo en unos minutos.",
});

// ⚠️ `/activas` va ANTES de `/:id`: con el orden invertido Express matchea
// "activas" como un id y la ruta se vuelve inalcanzable. Mismo pisotón que
// evitan `/products/import` y `/anuncios/orden`.
//
// Lleva `authOpcional` —no `requireAuth`— porque el panel usa el MISMO endpoint
// para recibir además su propio Doodle (`doodleEnAdmin`), y quién lo ve lo
// decide el token dentro del controller. Sin token la request sigue como
// anónima en vez de cortar con 401: en un endpoint público, una sesión de admin
// vencida rompería el logo del catálogo.
router.get("/activas", limitadorLecturaPublica, authOpcional, campaniasController.contextoActivo);

// También antes de `/:id`: los diccionarios que consume el panel, para que el
// frontend no tenga copia de las listas de tipos y estados.
router.get("/opciones", requireAuth, campaniasController.opciones);

router.get("/", requireAuth, campaniasController.listar);
router.post("/", requireAuth, campaniasController.crear);

// También antes de `/:id`, por lo mismo.
router.post("/:id/duplicar", requireAuth, campaniasController.duplicar);
router.patch("/:id/estado", requireAuth, campaniasController.cambiarEstado);
router.put("/:id/doodle", requireAuth, uploadDoodle.single("doodle"), campaniasController.guardarDoodle);
router.delete("/:id/doodle", requireAuth, campaniasController.quitarDoodle);

router.get("/:id", requireAuth, campaniasController.obtenerPorId);
router.put("/:id", requireAuth, campaniasController.actualizar);
router.delete("/:id", requireAuth, requierePermisoDeBorrado, campaniasController.eliminar);

export default router;
