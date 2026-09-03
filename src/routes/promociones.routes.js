import { Router } from "express";
import * as promocionesController from "../controllers/promociones.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { requierePermisoDeBorrado } from "../middlewares/permisoBorrado.middleware.js";

const router = Router();

/**
 * ADMIN → Promociones. **Todo el módulo exige auth**: no hay ninguna lectura
 * pública acá. Los descuentos que el catálogo necesita ya viajan resueltos en
 * `GET /products`, así que un endpoint público de promociones solo agregaría
 * superficie — y una de las peores, porque expone costo y coeficiente.
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

router.get("/:id", requireAuth, promocionesController.obtenerPorId);
router.put("/:id", requireAuth, promocionesController.actualizar);
router.delete("/:id", requireAuth, requierePermisoDeBorrado, promocionesController.eliminar);

export default router;
