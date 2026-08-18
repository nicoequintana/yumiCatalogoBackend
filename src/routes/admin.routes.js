import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import * as adminController from "../controllers/admin.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/error-logs", adminController.listarErrorLogs);

export default router;
