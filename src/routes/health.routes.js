import { Router } from "express";
import * as healthController from "../controllers/health.controller.js";

const router = Router();

// Sin rate limit a propósito: lo consulta el orquestador cada pocos segundos y
// limitarlo dejaría al contenedor marcado como caído por su propia defensa. La
// consulta que hace es la más barata que existe (`SELECT 1`) y no devuelve
// ningún dato del negocio.
router.get("/", healthController.estado);

export default router;
