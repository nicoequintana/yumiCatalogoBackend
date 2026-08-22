import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { truncarTexto } from "../lib/limitesTexto.js";

// `EventoTrafico.tipo` es `VarChar(30)`, no un enum de Prisma: agregar un tipo
// acá no requiere migración de base de datos.
//
// Esta lista es SOLO lo que acepta la API pública, y es un SUBCONJUNTO
// deliberado de los seis tipos del modelo: los únicos que el frontend emite
// por HTTP (`registrarEvento` en `frontend/src/api/products.js`, usado por
// `BotonWhatsapp` y `BotonAgregarCarrito`). Los otros cuatro
// (`VISTA_PRODUCTO`, `COMPARTIDO`, `FAVORITO_AGREGADO`, `ORDEN_CREADA`) los
// emite el backend con escritura directa vía `lib/logEvento.js` — aceptarlos
// acá dejaba que cualquiera fabricara eventos de etapas del embudo dentro del
// rate limit y envenenara la analytics.
const TIPOS_VALIDOS = ["CLICK_WHATSAPP", "AGREGADO_CARRITO"];

export async function crear(req, res, next) {
  try {
    const { tipo } = req.body ?? {};
    if (!tipo || !TIPOS_VALIDOS.includes(tipo)) {
      throw httpError(400, "El tipo de evento no es válido.");
    }

    let productId = null;
    if (req.body?.productId !== undefined && req.body?.productId !== null) {
      productId = Number(req.body.productId);
      if (!Number.isInteger(productId) || productId <= 0) {
        throw httpError(400, "productId debe ser un entero positivo.");
      }
    }

    const evento = await prisma.eventoTrafico.create({
      data: {
        tipo,
        productId,
        // Recortados al largo de su columna (NVarChar(1000)): un header más
        // largo producía un P2000 -> 500 público. Ver `lib/limitesTexto.js`.
        referrer: truncarTexto(req.get("Referer")),
        userAgent: truncarTexto(req.get("User-Agent")),
      },
    });

    res.status(201).json({ id: evento.id });
  } catch (err) {
    next(err);
  }
}
