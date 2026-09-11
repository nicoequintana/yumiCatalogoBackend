import { Router } from "express";
import { exigirOrigen } from "../middlewares/exigirOrigen.middleware.js";
import { requireCliente } from "../middlewares/authCliente.middleware.js";
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

// Login, código y recuperación: públicos, protegidos por los limitadores de
// la tabla "Rate limiting" de la spec (`docs/superpowers/specs/...#endurecimiento`).
router.post("/login", limitadores.loginIp, cuentaController.login);
router.post("/login/codigo", limitadores.codigoIp, cuentaController.loginConCodigo);
router.post(
  "/login/codigo/reenviar",
  limitadores.codigoReenviarIp,
  limitadores.codigoReenviarDestino,
  cuentaController.reenviarCodigo,
);

// `POST /cuenta/google` (Task 3) va acá cuando `google-auth-library` se
// declare en package.json/lock (Ruling C, progress.md): queda deferida a
// propósito, no es un olvido.

router.post("/olvide", limitadores.olvideIp, limitadores.olvideDestino, cuentaController.olvide);
router.post("/restablecer", limitadores.restablecerIp, cuentaController.restablecer);

// `email/confirmar` es un link de mail: sin sesión, por eso NO lleva
// `requireCliente` (Task 7 report). Comparte balde con `PUT /email` porque
// las dos tocan el mismo recurso y no hay una fila propia en la spec.
router.post("/email/confirmar", limitadores.emailIp, cuentaController.confirmarEmail);

// De acá para abajo, todo exige sesión de cliente.
router.post("/salir", requireCliente, cuentaController.salir);
router.get("/", requireCliente, cuentaController.obtenerPerfil);
router.put("/", requireCliente, cuentaController.actualizarPerfil);
router.put("/password", requireCliente, limitadores.passwordIp, cuentaController.cambiarPassword);
router.put("/email", requireCliente, limitadores.emailIp, cuentaController.cambiarEmail);

export default router;
