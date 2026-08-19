import { Router } from "express";
import * as authController from "../controllers/auth.controller.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// 8 intentos cada 15 minutos por IP: suficientemente ajustado para frenar
// fuerza bruta/credential stuffing, pero con margen para typos legítimos o
// IPs compartidas (oficinas, redes móviles con NAT) sin bloquear de más.
const limitadorLogin = crearLimitadorDeVelocidad({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: "Demasiados intentos de inicio de sesión. Probá de nuevo en unos minutos.",
});

router.post("/login", limitadorLogin, authController.login);

export default router;
