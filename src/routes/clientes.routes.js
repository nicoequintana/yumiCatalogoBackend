import { Router } from "express";
import * as clientesController from "../controllers/clientes.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

router.get("/:dni/ordenes", requireAuth, clientesController.obtenerHistorialCliente);

export default router;
