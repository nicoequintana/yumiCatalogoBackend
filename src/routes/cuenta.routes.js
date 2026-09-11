import { Router } from "express";
import { exigirOrigen } from "../middlewares/exigirOrigen.middleware.js";
import { limitadores } from "../middlewares/limitadoresCuenta.js";
import * as cuentaController from "../controllers/cuenta.controller.js";

/**
 * Rutas de la cuenta de CLIENTE. La sesión viaja en cookie (decisión 10), así
 * que toda mutación pasa por `exigirOrigen` ANTES de cualquier handler: es la
 * segunda capa contra CSRF. Se monta a nivel de router para que ninguna ruta
 * nueva pueda olvidarse de ponerlo.
 *
 * El resto de las rutas las agrega la Parte 2b del plan. Regla del repo: toda
 * ruta con segmento literal va declarada ANTES de las `/:id` del mismo método.
 */
const router = Router();

router.use(exigirOrigen);

router.post("/registro", limitadores.registroIp, limitadores.registroDestino, cuentaController.registro);
router.post("/verificar", limitadores.verificarIp, cuentaController.verificar);
router.post("/reenviar-verificacion", limitadores.reenviarVerificacionIp, cuentaController.reenviarVerificacion);

// La Parte 2b agrega las de login, Google, recuperación y perfil DESPUÉS de estas.

export default router;
