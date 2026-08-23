import { Router } from "express";
import * as anunciosController from "../controllers/anuncios.controller.js";
import { requireAuth, authOpcional } from "../middlewares/auth.middleware.js";

const router = Router();

// GET es PÚBLICO: la cinta de anuncios (`BarraAnuncios`) se muestra en el
// catálogo, que se navega sin login. Lleva `authOpcional` —no `requireAuth`—
// porque el panel usa el MISMO endpoint para ver también los inactivos, y quién
// los ve lo decide el token dentro del controller (`esRequestDeAdmin`). Sin
// token la request sigue como anónima en vez de cortar con 401, que en un
// endpoint público convertiría una sesión vencida en una cinta rota.
router.get("/", authOpcional, anunciosController.listar);

// ANTES de `/:id`: con el orden invertido, Express matchea "orden" como un id y
// esta ruta se vuelve inalcanzable. Mismo pisotón que evitan `/products/import`
// y `/products/eliminar-masivo`.
router.put("/orden", requireAuth, anunciosController.reordenar);

router.post("/", requireAuth, anunciosController.crear);
router.put("/:id", requireAuth, anunciosController.actualizar);
router.delete("/:id", requireAuth, anunciosController.eliminar);

export default router;
