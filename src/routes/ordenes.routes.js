import { Router } from "express";
import * as ordenesController from "../controllers/ordenes.controller.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// POST /api/ordenes es público (checkout de invitado, sin login) y de
// escritura crítica de negocio, así que va más ajustado que un endpoint de
// lectura pero con margen para un cliente legítimo mandando 2-3 pedidos en
// la misma sesión: 10 órdenes cada 10 minutos por IP. Más laxo que el
// limitador de login (8/15min, pensado contra fuerza bruta de credenciales)
// porque acá no hay credenciales que probar — el riesgo es spam/abuso del
// formulario, no takeover de cuenta.
const limitadorCrearOrden = crearLimitadorDeVelocidad({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: "Demasiados pedidos creados. Probá de nuevo en unos minutos.",
});

router.post("/", limitadorCrearOrden, ordenesController.crear);

export default router;
