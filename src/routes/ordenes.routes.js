import { Router } from "express";
import * as ordenesController from "../controllers/ordenes.controller.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";
import { requireAuth } from "../middlewares/auth.middleware.js";
import { authClienteOpcional } from "../middlewares/authCliente.middleware.js";
import { checkoutRequiereCuenta } from "../lib/env.js";

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

/**
 * Corta el checkout cuando la decisión 7 de la spec (publicación en dos
 * etapas) tiene el flag activo y no hay sesión de cliente.
 *
 * Va DESPUÉS de `authClienteOpcional` (necesita saber si hay sesión: nunca
 * corta a alguien logueado) y ANTES del limitador: un 401 por falta de
 * sesión no puede consumir la cuota de 10 pedidos/10min de la IP — si lo
 * hiciera, un script que golpea el endpoint sin cookie podría agotarle la
 * cuota a un comprador real que comparte esa IP (CGNAT, oficina).
 *
 * El flag se lee EN CADA REQUEST (llamando a `checkoutRequiereCuenta()`
 * dentro del handler, nunca guardado en una constante de módulo) para que un
 * test pueda cambiar `process.env.CHECKOUT_REQUIERE_CUENTA` entre casos sin
 * reimportar el router, y para que un operador pueda prender el flag en
 * producción sin un redeploy — solo un reinicio.
 */
function exigirCuentaSiElFlag(req, res, next) {
  if (checkoutRequiereCuenta() && !req.cuentaCliente) {
    return res.status(401).json({
      error: "Necesitás iniciar sesión para completar tu compra.",
      codigo: "SESION_INVALIDA",
    });
  }
  next();
}

router.post("/", authClienteOpcional, exigirCuentaSiElFlag, limitadorCrearOrden, ordenesController.crear);

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

// Declarada ANTES de `/:id` — el pisotón de siempre: si no, Express matchea
// "estados" como un id de orden. Mismo motivo que `/export` y
// `/productos-solicitados` acá arriba.
router.get("/estados", requireAuth, ordenesController.estados);

// También ANTES de `/:id`, por el mismo pisotón: puesta después, Express le
// pasa "resumen" a `obtenerPorId` como si fuera un id y el tablero recibe el
// 404 de una orden inexistente en vez de sus contadores.
router.get("/resumen", requireAuth, ordenesController.resumen);
router.get("/:id", requireAuth, ordenesController.obtenerPorId);
router.patch("/:id/estado", requireAuth, ordenesController.actualizarEstado);

export default router;
