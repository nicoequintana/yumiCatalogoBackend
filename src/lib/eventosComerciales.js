import { httpError } from "./httpError.js";

/**
 * Los diccionarios de las métricas del cartel y del slide.
 *
 * Viven en `lib/` y no en el controller porque los consumen dos cosas: la
 * validación del `POST /:id/evento` y el endpoint de lectura, que agrupa por
 * `origen` y necesita saber cuáles existen para emitir un cero explícito en
 * el que no tenga eventos (un `groupBy` omite los grupos vacíos).
 *
 * "Comercial" sigue a `useContextoComercial`, la casa del cartel y los slides
 * del lado del frontend: es el término que el repo ya usa para el conjunto
 * de campañas y promociones.
 */
export const TIPOS_COMERCIALES = ["IMPRESION_COMERCIAL", "CLICK_COMERCIAL"];
export const ORIGENES_COMERCIALES = ["MODAL", "BANNER"];
// Los cuatro primeros son `TIPOS_DESTINO_CTA` de `lib/campanias.js` (la
// intención del CTA del cartel, que el slide de campaña reusa). `PROMOCION`
// es el quinto y es fijo: el slide de una promoción siempre lleva a su
// vitrina y no es configurable.
export const DESTINOS_COMERCIALES = ["CAMPANIA", "CATALOGO", "CATEGORIA", "PRODUCTO", "PROMOCION"];

/**
 * Valida el cuerpo de un evento comercial y devuelve los tres campos ya
 * normalizados. `destino` es OBLIGATORIO en un click y PROHIBIDO en una
 * impresión: una impresión todavía no decidió nada, así que un destino ahí
 * es un cuerpo mal armado, no un dato.
 *
 * Los seis tipos históricos de `EventoTrafico` se rechazan acá: esta puerta
 * es solo para los dos comerciales, nunca una segunda forma de fabricar
 * `VISTA_PRODUCTO` desde afuera.
 *
 * @param {unknown} body
 * @returns {{ tipo: string, origen: string, destino: string | null }}
 */
export function validarEventoComercial(body) {
  const { tipo, origen, destino } = body ?? {};

  if (!TIPOS_COMERCIALES.includes(tipo)) {
    throw httpError(400, "El tipo de evento no es válido.");
  }
  if (!ORIGENES_COMERCIALES.includes(origen)) {
    throw httpError(400, "El origen del evento no es válido.");
  }

  if (tipo === "CLICK_COMERCIAL") {
    if (!DESTINOS_COMERCIALES.includes(destino)) {
      throw httpError(400, "El destino del click no es válido.");
    }
    return { tipo, origen, destino };
  }

  if (destino !== undefined && destino !== null) {
    throw httpError(400, "Una impresión no lleva destino.");
  }
  return { tipo, origen, destino: null };
}
