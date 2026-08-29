import { Router } from "express";
import multer from "multer";
import * as productsController from "../controllers/products.controller.js";
import * as productsMediaController from "../controllers/productsMedia.controller.js";
import * as productsImportController from "../controllers/productsImport.controller.js";
import * as imagenesGeneradasController from "../controllers/productsImagenesGeneradas.controller.js";
import { authOpcional, requireAuth } from "../middlewares/auth.middleware.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";
import { MAX_FOTOS, MAX_VIDEOS, MAX_FOTO_BYTES, ALLOWED_PHOTO_MIMES } from "../lib/limitesMedios.js";
import { MAX_REFERENCIAS } from "../services/n8n.service.js";

const ALLOWED_VIDEO_MIMES = ["video/mp4", "video/webm"];

// Global multer limit is the video ceiling (design: ~100MB video / ~15MB
// photo). Multer can't apply a different fileSize per field, so the
// per-field 15MB photo cap is enforced manually in the controller.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    // `status` explícito en los tres rechazos, mismo pitfall que documenta el
    // filtro del .xlsx más abajo: sin él, el error handler central trata el
    // error como interno (500), le esconde al admin el mensaje que nombra los
    // formatos aceptados y encima ensucia `ErrorLog` con un error del usuario.
    if (file.fieldname === "fotos") {
      if (!ALLOWED_PHOTO_MIMES.includes(file.mimetype)) {
        const err = new Error("Tipo de imagen no permitido. Use JPEG, PNG o WEBP.");
        err.status = 400;
        return cb(err);
      }
      return cb(null, true);
    }
    if (file.fieldname === "video") {
      if (!ALLOWED_VIDEO_MIMES.includes(file.mimetype)) {
        const err = new Error("Tipo de video no permitido. Use MP4 o WEBM.");
        err.status = 400;
        return cb(err);
      }
      return cb(null, true);
    }
    const err = new Error("Campo de archivo inesperado.");
    err.status = 400;
    cb(err);
  },
});

const uploadFields = upload.fields([
  { name: "fotos", maxCount: MAX_FOTOS },
  { name: "video", maxCount: MAX_VIDEOS },
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

// Multer propio para las referencias del flujo de generación de imágenes de
// n8n. No se puede reusar `uploadFields`: su `fileFilter` rechaza cualquier
// campo que no sea `fotos` o `video` con "Campo de archivo inesperado".
//
// El tope de tamaño es `MAX_FOTO_BYTES` —el mismo de las fotos del producto— y
// acá SÍ se puede poner en multer, porque este uploader no maneja videos y
// entonces no tiene el conflicto de un `fileSize` único por instancia que
// obliga a validar a mano en el alta de producto.
const uploadReferencias = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FOTO_BYTES, files: MAX_REFERENCIAS },
  fileFilter(_req, file, cb) {
    if (file.fieldname !== "referencias") {
      const err = new Error("Campo de archivo inesperado.");
      err.status = 400;
      return cb(err);
    }
    if (!ALLOWED_PHOTO_MIMES.includes(file.mimetype)) {
      // `status` explícito por el mismo motivo que los otros filtros de este
      // archivo: sin él, el error handler central lo trata como interno y el
      // admin ve un 500 en vez del mensaje que le dice qué formatos sirven.
      const err = new Error("Tipo de imagen no permitido. Use JPEG, PNG o WEBP.");
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
}).fields([{ name: "referencias", maxCount: MAX_REFERENCIAS }]);

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

// `authOpcional` en los dos GET públicos: siguen sirviendo a visitantes
// anónimos, pero cuando el llamador presenta un JWT válido el controller lo ve
// en `req.usuario` y habilita la vista admin (ocultos + agotados). Es lo que
// reemplaza al viejo `?admin=1`, que otorgaba esa vista a cualquiera.
router.get("/", authOpcional, productsController.listar);
router.get("/import/template", requireAuth, productsImportController.descargarPlantilla);
// `/export` alimenta el flujo de ACTUALIZACIÓN masiva (exportar -> editar a
// mano -> volver a subir). Va ANTES de `GET /:id`, mismo motivo que
// `/import/template`: si no, Express matchea "export" como el `:id`.
router.get("/export", requireAuth, productsImportController.exportar);
// Conteos de catálogo del encabezado del listado del admin. Va ANTES de
// `GET /:id` por el mismo pisotón que `/import/template` y `/export`: si no,
// Express matchea "resumen" como el `:id` y el detalle contesta 404.
router.get("/resumen", requireAuth, productsController.resumen);
// Los dos proxies de media también llevan `authOpcional`: la media de un
// producto oculto no puede seguir siendo pública solo porque se la pida por
// otra URL. Siguen sirviendo a visitantes anónimos —las fotos de un producto
// publicado nunca fueron secretas—, pero un producto con
// `visibleEnCatalogo: false` responde 404 salvo que el llamador presente un
// JWT válido.
router.get("/:id/video", authOpcional, productsMediaController.streamVideo);
router.get("/:id/fotos/:fotoId", authOpcional, productsMediaController.streamFoto);
router.get("/:id", authOpcional, productsController.obtenerPorId);
router.post("/import", requireAuth, uploadXlsx, productsImportController.importar);
// Acciones masivas del listado del admin. Van ANTES de cualquier ruta `/:id`
// del mismo método: si se declararan después, Express matchearía
// "eliminar-masivo" como un id y el handler correcto nunca correría. Mismo
// pisotón que ya evita `/import` unas líneas más arriba.
router.post("/eliminar-masivo", requireAuth, productsController.eliminarMasivo);
router.patch("/visibilidad-masiva", requireAuth, productsController.actualizarVisibilidadMasiva);
// Aplica el precio calculado (`costo × coeficiente`) a los productos
// seleccionados en `/catalogo/admin/productos/precios`. Mismo pisotón que las
// otras masivas: va ANTES de cualquier `POST /:id/...`.
router.post("/precios-masivo", requireAuth, productsController.aplicarPreciosMasivo);
// Actualización masiva por planilla (matcheo por SKU, nunca crea). Mismo
// multer `uploadXlsx` que `/import`.
router.post("/actualizar-masivo", requireAuth, uploadXlsx, productsImportController.actualizarMasivo);
router.post("/", requireAuth, uploadFields, productsController.crear);
// `authOpcional` también acá: los dos endpoints siguen siendo públicos, pero
// necesitan saber si el llamador es admin para aplicar la misma paridad de 404
// que `obtenerPorId` — un producto oculto tiene que responder igual que uno
// inexistente, y solo un JWT verificado levanta esa guarda.
router.post("/:id/compartir", limitadorInteraccionesPublicas, authOpcional, productsController.compartir);
router.post("/:id/favorito", limitadorInteraccionesPublicas, authOpcional, productsController.favorito);
// Dispara el flujo de n8n que genera las imágenes del producto. No colisiona
// con ninguna otra ruta POST: las que existen son `/`, `/import`,
// `/eliminar-masivo`, `/actualizar-masivo`, `/:id/compartir` y `/:id/favorito`.
router.post("/:id/generar-imagenes", requireAuth, uploadReferencias, productsController.generarImagenes);
// Carpeta de imágenes generadas por n8n (`productos/{sku}`). El DELETE NO
// borra las que ya son fotos del producto: son el mismo archivo.
router.get("/:id/imagenes-generadas", requireAuth, imagenesGeneradasController.listar);
router.post("/:id/imagenes-generadas/adoptar", requireAuth, imagenesGeneradasController.adoptar);
router.delete("/:id/imagenes-generadas", requireAuth, imagenesGeneradasController.borrar);
router.put("/:id", requireAuth, uploadFields, productsController.actualizar);
router.patch("/:id/visibilidad", requireAuth, productsController.actualizarVisibilidad);
router.patch("/:id/merchandising", requireAuth, productsController.actualizarMerchandising);
// Costo y coeficiente desde la tabla de precios, guardado al instante. NO toca
// `precio`: publicarlo es un paso aparte y explícito (`/precios-masivo`).
router.patch("/:id/costeo", requireAuth, productsController.actualizarCosteo);
router.delete("/:id", requireAuth, productsController.eliminar);
router.delete("/:id/fotos/:fotoId", requireAuth, productsController.eliminarFoto);

export default router;
