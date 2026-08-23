import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import * as adminController from "../controllers/admin.controller.js";
import * as adminOperacionController from "../controllers/adminOperacion.controller.js";
import * as adminClientesController from "../controllers/adminClientes.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/error-logs", adminController.listarErrorLogs);
router.get("/audit-logs", adminController.listarAuditLogs);
router.get("/ventas", adminController.resumenVentas);
router.get("/embudo", adminController.embudoConversion);
router.get("/clientes-resumen", adminClientesController.resumenClientes);
router.get("/operacion", adminOperacionController.resumenOperacion);

export default router;
