import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import * as adminController from "../controllers/admin.controller.js";
import * as adminOperacionController from "../controllers/adminOperacion.controller.js";
import * as adminClientesController from "../controllers/adminClientes.controller.js";
import * as metricasComercialesController from "../controllers/metricasComerciales.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/error-logs", adminController.listarErrorLogs);
router.get("/audit-logs", adminController.listarAuditLogs);
router.get("/ventas", adminController.resumenVentas);
router.get("/embudo", adminController.embudoConversion);
// Impresiones, clicks y etapas por campaña y promoción, cada una en SU período.
router.get("/metricas-comerciales", metricasComercialesController.metricasComerciales);
router.get("/clientes-resumen", adminClientesController.resumenClientes);
router.get("/operacion", adminOperacionController.resumenOperacion);

export default router;
