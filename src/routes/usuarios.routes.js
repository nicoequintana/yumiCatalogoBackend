import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware.js";
import {
  requierePermisoDeBorrado,
  requierePermisoParaActualizarUsuario,
} from "../middlewares/permisoBorrado.middleware.js";
import * as usuariosController from "../controllers/usuarios.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/", usuariosController.listar);
// H-01: el alta de usuarios exige el mismo permiso que el borrado — un
// usuario sin `puedeEliminar` no puede crear un usuario nuevo con el permiso
// activado. Ver `docs/reglas/seguridad-y-arranque.md`.
router.post("/", requierePermisoDeBorrado, usuariosController.crear);
router.put("/:id", requierePermisoParaActualizarUsuario, usuariosController.actualizar);
router.delete("/:id", requierePermisoDeBorrado, usuariosController.eliminar);

export default router;
