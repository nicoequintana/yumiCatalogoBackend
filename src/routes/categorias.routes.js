import { Router } from "express";
import * as categoriasController from "../controllers/categorias.controller.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

const router = Router();

// GET es PÚBLICO a propósito: el listado de categorías alimenta los filtros
// de la página pública `/coleccion` (`Coleccion.jsx`), que se navega sin
// login. Las tres rutas de escritura, en cambio, son operaciones del panel
// admin y van protegidas — antes no lo estaban.
router.get("/", categoriasController.listar);
router.post("/", requireAuth, categoriasController.crear);
router.put("/:id", requireAuth, categoriasController.actualizar);
router.delete("/:id", requireAuth, categoriasController.eliminar);

export default router;
