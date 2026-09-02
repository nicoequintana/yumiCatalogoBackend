import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { requierePermisoDeBorrado } from "../middlewares/permisoBorrado.middleware.js";
import * as usuariosController from "../controllers/usuarios.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", usuariosController.listar);
router.post("/", usuariosController.crear);
router.put("/:id", usuariosController.actualizar);
router.delete("/:id", requierePermisoDeBorrado, usuariosController.eliminar);

export default router;
