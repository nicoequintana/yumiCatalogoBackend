import { Router } from "express";
import { exigirOrigen } from "../middlewares/exigirOrigen.middleware.js";
import { requireCliente } from "../middlewares/authCliente.middleware.js";
import { limitadores } from "../middlewares/limitadoresCuenta.js";
import * as registroController from "../controllers/cuentaRegistro.controller.js";
import * as loginController from "../controllers/cuentaLogin.controller.js";
import * as recuperacionController from "../controllers/cuentaRecuperacion.controller.js";
import * as perfilController from "../controllers/cuentaPerfil.controller.js";

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

router.post("/registro", limitadores.registroIp, limitadores.registroDestino, registroController.registro);
router.post("/verificar", limitadores.verificarIp, registroController.verificar);
router.post("/reenviar-verificacion", limitadores.reenviarVerificacionIp, registroController.reenviarVerificacion);

// Login, código y recuperación: públicos, protegidos por los limitadores de
// la tabla "Rate limiting" de la spec (`docs/superpowers/specs/...#endurecimiento`).
router.post("/login", limitadores.loginIp, loginController.login);
router.post("/login/codigo", limitadores.codigoIp, loginController.loginConCodigo);
router.post(
  "/login/codigo/reenviar",
  limitadores.codigoReenviarIp,
  limitadores.codigoReenviarDestino,
  loginController.reenviarCodigo,
);

// `POST /cuenta/google` (Task 3) va acá cuando `google-auth-library` se
// declare en package.json/lock (Ruling C, progress.md): queda deferida a
// propósito, no es un olvido.

router.post("/olvide", limitadores.olvideIp, limitadores.olvideDestino, recuperacionController.olvide);
router.post("/restablecer", limitadores.restablecerIp, recuperacionController.restablecer);

// `email/confirmar` es un link de mail: sin sesión, por eso NO lleva
// `requireCliente` (Task 7 report). Comparte balde con `PUT /email` porque
// las dos tocan el mismo recurso y no hay una fila propia en la spec.
router.post("/email/confirmar", limitadores.emailIp, perfilController.confirmarEmail);

// De acá para abajo, todo exige sesión de cliente.
router.post("/salir", requireCliente, loginController.salir);
router.get("/", requireCliente, perfilController.obtenerPerfil);
router.put("/", requireCliente, perfilController.actualizarPerfil);
router.put("/password", requireCliente, limitadores.passwordIp, perfilController.cambiarPassword);
router.put("/email", requireCliente, limitadores.emailIp, perfilController.cambiarEmail);

export default router;
