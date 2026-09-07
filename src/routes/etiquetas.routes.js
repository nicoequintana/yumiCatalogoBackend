import { Router } from "express";
import * as etiquetasController from "../controllers/etiquetas.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { requierePermisoDeBorrado } from "../middlewares/permisoBorrado.middleware.js";

const router = Router();

// El recurso ENTERO va detrás de `requireAuth`, incluido el GET: el catálogo
// público nunca pide la lista de etiquetas, porque el color de cada chip viaja
// ya resuelto dentro del producto (`products.mapper.js`). Sin consumidor
// público, exponerlo solo agrandaría la superficie.
router.get("/", requireAuth, etiquetasController.listar);

// ANTES de `/:id`: con el orden invertido Express matchea "opciones" como un id
// y esta ruta se vuelve inalcanzable. Mismo pisotón que evitan
// `/campanias/opciones` y `/products/import`.
router.get("/opciones", requireAuth, etiquetasController.opciones);

router.post("/", requireAuth, etiquetasController.crear);
router.put("/:id", requireAuth, etiquetasController.actualizar);
router.delete("/:id", requireAuth, requierePermisoDeBorrado, etiquetasController.eliminar);

export default router;
