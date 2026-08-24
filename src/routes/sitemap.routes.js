import { Router } from "express";
import { servirSitemap } from "../controllers/sitemap.controller.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// Público, sin auth, y cada request arma el sitemap consultando la base (hasta
// MAX_URLS_SITEMAP filas). Un crawler legítimo pide el sitemap unas pocas
// veces por día; 30 cada 5 minutos por IP es órdenes de magnitud más que eso
// (varios crawlers detrás de una misma IP incluidos) y aun así corta el abuso
// de usar este endpoint para golpear la base en loop.
const limitadorSitemap = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: "Demasiadas solicitudes. Probá de nuevo en unos minutos.",
});

router.get("/", limitadorSitemap, servirSitemap);

export default router;
