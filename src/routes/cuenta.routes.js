import { Router } from "express";
import { exigirOrigen } from "../middlewares/exigirOrigen.middleware.js";

/**
 * Rutas de la cuenta de CLIENTE. La sesión viaja en cookie (decisión 10), así
 * que toda mutación pasa por `exigirOrigen` ANTES de cualquier handler: es la
 * segunda capa contra CSRF. Se monta a nivel de router para que ninguna ruta
 * nueva pueda olvidarse de ponerlo.
 *
 * Las rutas las agrega la Parte 2 del plan. Regla del repo: toda ruta con
 * segmento literal va declarada ANTES de las `/:id` del mismo método.
 */
const router = Router();

router.use(exigirOrigen);

export default router;
