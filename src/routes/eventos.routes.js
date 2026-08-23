import { Router } from "express";
import * as eventosController from "../controllers/eventos.controller.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// POST /api/eventos es público y sin auth, y cada request inserta una fila en
// `EventoTrafico` — la tabla que más rápido crece del modelo. Sin limitador,
// cualquiera puede inflarla indefinidamente.
//
// El límite tiene que ser MUCHO más laxo que el de login (8/15min) o el de
// órdenes (10/10min): esto no es una acción deliberada del usuario sino un
// beacon de analytics que se dispara durante la navegación normal, y el
// contador es por IP — una oficina o una red móvil con NAT comparte una sola
// IP entre muchos visitantes. 300 cada 5 minutos deja margen para un pico de
// tráfico real (equivale a 1 evento por segundo sostenido) y sigue frenando
// el scripting masivo de la tabla.
const limitadorEventos = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 300,
  message: "Demasiadas solicitudes. Probá de nuevo en unos minutos.",
});

router.post("/", limitadorEventos, eventosController.crear);

export default router;
