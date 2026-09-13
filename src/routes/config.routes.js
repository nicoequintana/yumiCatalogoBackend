import { Router } from "express";
import * as configController from "../controllers/config.controller.js";
import { requireAuth, authOpcional } from "../middlewares/auth.middleware.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// Mismo techo que la lectura pública de `GET /anuncios` (600/5min por IP): se
// pide sin login en cada carga del catálogo (WhatsApp, mail, redes,
// dirección) y no tenía ningún límite.
const limitadorLecturaPublica = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: "Demasiadas solicitudes seguidas. Probá de nuevo en unos minutos.",
});

router.get("/whatsapp", configController.whatsapp);

// `authOpcional`: mismo endpoint para el catálogo público y para el panel —
// quién ve `crudo` lo decide el TOKEN dentro del controller
// (`esRequestDeAdmin`), nunca la querystring.
router.get("/contacto", limitadorLecturaPublica, authOpcional, configController.contacto);

router.put("/contacto", requireAuth, configController.actualizarContacto);

export default router;
