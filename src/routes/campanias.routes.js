import { Router } from "express";
import multer from "multer";
import * as campaniasController from "../controllers/campanias.controller.js";
import * as eventosComercialesController from "../controllers/eventosComerciales.controller.js";
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

// Mismo storage y mismo `fileFilter` que el Doodle. Instancia propia (y no
// compartida) para que el campo multipart que cada una espera —"doodle" o
// "arte"— quede en el nombre de la variable, no en un parámetro que hay que
// ir a buscar.
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

// Mismo techo que la cinta de anuncios (600/5min por IP) y por el mismo motivo:
// el catálogo pide esto en cada carga de página, sin login y pegándole a la
// base. 600 es holgadísimo para navegación humana y corta el flood.
const limitadorLecturaPublica = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: "Demasiadas solicitudes seguidas. Probá de nuevo en unos minutos.",
});

// Impresiones y clicks del cartel y del slide.
//
// **El techo se cuenta en CARGAS DE PÁGINA, no en eventos**: 1800 = 600 cargas
// × ~3 eventos por carga (la impresión del cartel, la del slide visible y un
// click). Ese 600 es el mismo de `/activas` y el de la cinta de anuncios, y
// una oficina detrás de un NAT comparte una sola IP.
//
// Con 600 acá el número mentía: `/activas` es UN request por carga y sin él no
// existe ningún evento, así que la LECTURA toleraba 600 cargas y la ESCRITURA
// solo 200 — la escritura era la restricción vinculante antes que la lectura,
// que está al revés. Ver eventosComerciales.controller.js.
const limitadorEventosComerciales = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 1800,
  message: "Demasiadas solicitudes. Probá de nuevo en unos minutos.",
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

// Ídem: cuántos días faltan hasta una fecha. El día lo cuenta el BACKEND, que
// es el único que tiene la definición de "día" del sistema.
router.get("/contador", requireAuth, campaniasController.contador);

router.get("/", requireAuth, campaniasController.listar);
router.post("/", requireAuth, campaniasController.crear);

// También antes de `/:id`, por lo mismo.
router.post("/:id/duplicar", requireAuth, campaniasController.duplicar);
// Pública: la emite el navegador de cualquier visitante. El literal va DESPUÉS
// del `:id`, así que no cae en la regla de "literal antes de /:id" — no hay
// otra POST /:id/<algo> con la que confundirse.
router.post("/:id/evento", limitadorEventosComerciales, eventosComercialesController.crearDeCampania);
router.patch("/:id/estado", requireAuth, campaniasController.cambiarEstado);
// Qué promociones aplica la campaña mientras está activa. Apagar la campaña las
// apaga a todas de una: la vigencia la heredan de acá, no la guardan.
router.put("/:id/promociones", requireAuth, campaniasController.guardarPromociones);
// La VITRINA: qué productos MUESTRA la campaña. Es una lista distinta de la de
// promociones y no un subconjunto suyo — un producto puede estar en la vitrina
// de Navidad a precio de lista.
router.put("/:id/productos", requireAuth, campaniasController.guardarProductos);
router.put("/:id/doodle", requireAuth, uploadDoodle.single("doodle"), campaniasController.guardarDoodle);
router.delete("/:id/doodle", requireAuth, campaniasController.quitarDoodle);
// La pieza apaisada del slide: mismo patrón multipart que el Doodle, ruta y
// campo propios porque `PUT /:id` sigue siendo JSON puro.
router.put("/:id/arte", requireAuth, uploadArte.single("arte"), campaniasController.guardarArte);
router.delete("/:id/arte", requireAuth, campaniasController.quitarArte);

router.get("/:id", requireAuth, campaniasController.obtenerPorId);
router.put("/:id", requireAuth, campaniasController.actualizar);
router.delete("/:id", requireAuth, requierePermisoDeBorrado, campaniasController.eliminar);

export default router;
