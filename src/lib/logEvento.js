import { prisma } from "./prisma.js";
import { truncarTexto } from "./limitesTexto.js";

/**
 * Extrae `Referer` y `User-Agent` de un request de Express.
 *
 * Usa `req.get?.()` en vez de `req.get()` a propósito: el contrato de
 * `logEvento` es que emitir un evento NUNCA rompe el request que lo originó, y
 * eso tiene que valer también para leer los headers. Un `req` sin `get()` (un
 * doble de test, o una invocación del controller fuera del stack de Express)
 * degrada a `null` en vez de tirar un TypeError sincrónico que el emisor
 * fire-and-forget no podría atajar — el catch de adentro solo cubre el insert.
 *
 * @param {import("express").Request} [req]
 * @returns {{ referrer: string|null, userAgent: string|null }}
 */
export function headersDeEvento(req) {
  return {
    referrer: req?.get?.("Referer") ?? null,
    userAgent: req?.get?.("User-Agent") ?? null,
  };
}

/**
 * Best-effort traffic-event emitter — persiste una fila en `EventoTrafico`
 * (qué pasó, sobre qué producto, y de dónde venía el visitante).
 *
 * Mismo contrato que `logError.js` / `logAudit.js`: NUNCA lanza. Un evento de
 * analytics no puede romper el request que lo originó — el visitante ya vio su
 * producto, ya compartió el link, ya marcó el favorito. Los callers lo usan
 * fire-and-forget (sin await) para que la respuesta HTTP no espere el insert.
 * Si el insert falla, cae a `console.error` puramente como rastro de último
 * recurso, nunca como camino principal.
 *
 * Se invoca desde el backend con escritura directa a Prisma, no vía HTTP a
 * `POST /api/eventos` — ese endpoint existe para los emisores del frontend
 * (ver `registrarEvento` en `frontend/src/api/products.js`). `tipo` tiene que
 * ser uno de los valores de `TIPOS_VALIDOS` de `eventos.controller.js`; la
 * columna es `VarChar(30)`, no un enum de Prisma, así que agregar un tipo
 * nuevo no requiere migración.
 *
 * Nunca recibe ni persiste la IP del visitante: `EventoTrafico` guarda
 * referrer y user-agent, deliberadamente nada que identifique a la persona.
 *
 * @param {object} params
 * @param {string} params.tipo VISTA_PRODUCTO | CLICK_WHATSAPP | FAVORITO_AGREGADO | AGREGADO_CARRITO | ORDEN_CREADA | COMPARTIDO
 * @param {number} [params.productId] producto al que aplica el evento (los eventos de sitio, como ORDEN_CREADA, van sin él)
 * @param {string} [params.referrer] header `Referer` del request que originó el evento
 * @param {string} [params.userAgent] header `User-Agent` del request que originó el evento
 * @returns {Promise<void>}
 */
export async function logEvento({ tipo, productId, referrer, userAgent }) {
  try {
    await prisma.eventoTrafico.create({
      data: {
        tipo,
        productId: productId ?? null,
        // Recortados al largo de su columna (NVarChar(1000)): un header más
        // largo produce un P2000 y este insert best-effort perdería el evento
        // en silencio. Ver `lib/limitesTexto.js`.
        referrer: truncarTexto(referrer),
        userAgent: truncarTexto(userAgent),
      },
    });
  } catch (err) {
    console.error("logEvento: no se pudo persistir el EventoTrafico:", err);
  }
}
