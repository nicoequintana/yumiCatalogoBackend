import { Router } from "express";
import { servirOgProducto } from "../controllers/og.controller.js";

const router = Router();

router.get("/producto/:id", servirOgProducto);

export default router;
