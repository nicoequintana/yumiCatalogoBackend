import { Router } from "express";
import * as anunciosController from "../controllers/anuncios.controller.js";
import { requireAuth, authOpcional } from "../middlewares/auth.middleware.js";
import { crearLimitadorDeVelocidad } from "../middlewares/rateLimit.middleware.js";

const router = Router();

// Techo de lectura pública (600/5min por IP), mismo criterio que los GET
// públicos de producto: la cinta se lee sin login en cada carga del catálogo y
// pega a la base, y no tenía ningún límite. 600 es holgadísimo para navegación
// humana real y corta el flood/scraping.
const limitadorLecturaPublica = crearLimitadorDeVelocidad({
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: "Demasiadas solicitudes seguidas. Probá de nuevo en unos minutos.",
});

// GET es PÚBLICO: la cinta de anuncios (`BarraAnuncios`) se muestra en el
// catálogo, que se navega sin login. Lleva `authOpcional` —no `requireAuth`—
// porque el panel usa el MISMO endpoint para ver también los inactivos, y quién
// los ve lo decide el token dentro del controller (`esRequestDeAdmin`). Sin
// token la request sigue como anónima en vez de cortar con 401, que en un
// endpoint público convertiría una sesión vencida en una cinta rota.
router.get("/", limitadorLecturaPublica, authOpcional, anunciosController.listar);

// ANTES de `/:id`: con el orden invertido, Express matchea "orden" como un id y
// esta ruta se vuelve inalcanzable. Mismo pisotón que evitan `/products/import`
// y `/products/eliminar-masivo`.
router.put("/orden", requireAuth, anunciosController.reordenar);

router.post("/", requireAuth, anunciosController.crear);
router.put("/:id", requireAuth, anunciosController.actualizar);
router.delete("/:id", requireAuth, anunciosController.eliminar);

export default router;
