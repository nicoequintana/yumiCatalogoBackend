import { Router } from "express";
import * as eventosController from "../controllers/eventos.controller.js";

const router = Router();

router.post("/", eventosController.crear);

export default router;
