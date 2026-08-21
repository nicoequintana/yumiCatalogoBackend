import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";

// `EventoTrafico.tipo` es `VarChar(30)`, no un enum de Prisma: agregar un tipo
// acá no requiere migración de base de datos. Esta lista es la única fuente de
// verdad de qué tipos acepta la API pública; los emisores del backend escriben
// vía `logEvento.js` y deben usar alguno de estos mismos valores.
const TIPOS_VALIDOS = [
  "VISTA_PRODUCTO",
  "CLICK_WHATSAPP",
  "FAVORITO_AGREGADO",
  "AGREGADO_CARRITO",
  "ORDEN_CREADA",
  "COMPARTIDO",
];

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
        referrer: req.get("Referer") ?? null,
        userAgent: req.get("User-Agent") ?? null,
      },
    });

    res.status(201).json({ id: evento.id });
  } catch (err) {
    next(err);
  }
}
