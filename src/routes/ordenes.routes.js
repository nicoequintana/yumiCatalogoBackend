import { Router } from "express";
import * as ordenesController from "../controllers/ordenes.controller.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";
import { requireAuth } from "../middlewares/auth.middleware.js";

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

// Gestión admin de órdenes — todas protegidas con requireAuth (a diferencia
// del checkout de invitado arriba, que es público).
router.get("/", requireAuth, ordenesController.listar);

// DECLARADAS ANTES DE `/:id`: Express matchea por orden de registro, así que
// puestas después, `obtenerPorId` se quedaría con "productos-solicitados" como
// si fuera un id. Es el mismo pisotón que evitan `/products/import` y
// `/products/eliminar-masivo`. La ruta más específica (`/export`) va primero
// por el mismo motivo.
router.get(
  "/productos-solicitados/export",
  requireAuth,
  ordenesController.exportarProductosSolicitados,
);
router.get("/productos-solicitados", requireAuth, ordenesController.listarProductosSolicitados);

router.get("/:id", requireAuth, ordenesController.obtenerPorId);
router.patch("/:id/estado", requireAuth, ordenesController.actualizarEstado);

export default router;
