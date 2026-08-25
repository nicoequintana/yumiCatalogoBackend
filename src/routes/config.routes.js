import { Router } from "express";
import * as configController from "../controllers/config.controller.js";

const router = Router();

router.get("/whatsapp", configController.whatsapp);

export default router;
