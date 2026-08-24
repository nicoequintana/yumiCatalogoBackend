import { Router } from "express";
import {
  servirSeoProducto,
  servirSeoHome,
  servirSeoColeccion,
  servirSeoCategoria,
} from "../controllers/seo.controller.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// Público, sin auth, y con una consulta a la base por request: sin limitador,
// cualquiera puede martillarlo. El límite es LAXO a propósito — esto lo
// consumen los bots de redes sociales al armar el preview de un link
// compartido, y apretarlo rompería justo esos previews. 120 cada 5 minutos
// por IP banca a una plataforma re-scrapeando varios productos desde una
// misma IP y sigue frenando el scraping masivo del catálogo vía /og.
const limitadorOg = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: "Demasiadas solicitudes. Probá de nuevo en unos minutos.",
});

// El orden entre estas cuatro rutas NO importa para Express: son literales
// distintos (`/home`, `/coleccion`, `/categoria/:slug`) que nunca compiten
// por el mismo segmento que `/producto/:idSlug` — a diferencia del pisotón
// real que CLAUDE.md documenta para `/products/import` y
// `/products/eliminar-masivo`, donde la ruta con parámetro SÍ matchea un
// literal declarado después. Van en este orden por legibilidad (páginas de
// listado antes que la de detalle), no por necesidad.
router.get("/home", limitadorOg, servirSeoHome);
router.get("/coleccion", limitadorOg, servirSeoColeccion);
router.get("/categoria/:slug", limitadorOg, servirSeoCategoria);
router.get("/producto/:idSlug", limitadorOg, servirSeoProducto);

export default router;
