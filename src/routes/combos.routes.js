import { Router } from "express";
import * as combosController from "../controllers/combos.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { requierePermisoDeBorrado } from "../middlewares/permisoBorrado.middleware.js";

const router = Router();

router.get("/admin/combos", requireAuth, combosController.listarAdmin);
router.post("/admin/combos", requireAuth, combosController.crear);
router.get("/admin/combos/:id", requireAuth, combosController.obtenerAdminPorId);
router.put("/admin/combos/:id", requireAuth, combosController.actualizar);
router.delete("/admin/combos/:id", requireAuth, requierePermisoDeBorrado, combosController.eliminar);

export default router;
