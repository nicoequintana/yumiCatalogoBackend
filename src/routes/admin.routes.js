import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import * as adminController from "../controllers/admin.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/error-logs", adminController.listarErrorLogs);
router.get("/audit-logs", adminController.listarAuditLogs);
router.get("/ventas", adminController.resumenVentas);
router.get("/embudo", adminController.embudoConversion);

export default router;
