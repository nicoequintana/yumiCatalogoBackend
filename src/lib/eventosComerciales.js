import { httpError } from "./httpError.js";
import { ETIQUETA_DESTINO_CTA, TIPOS_DESTINO_CTA } from "./campanias.js";

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

/**
 * Los destinos que acepta un click: los `TIPOS_DESTINO_CTA` de `lib/campanias.js`
 * —la intención del CTA del cartel, que el slide de campaña reusa— más
 * `PROMOCION`, que es el quinto y es FIJO: el slide de una promoción siempre
 * lleva a su vitrina y no es configurable, así que no sale de esa lista.
 *
 * ⚠️ **Se DERIVA, no se copia.** Reescribir los cuatro a mano deja un modo de
 * falla mudo: una quinta intención de CTA la emitiría `/campanias/activas` en
 * `ctaTipo`, el frontend la mandaría acá y esta puerta contestaría 400 — los
 * clicks de esas campañas dejarían de contarse, con el síntoma "esta campaña
 * no tuvo clicks", que no señala a ningún lado.
 */
export const DESTINOS_COMERCIALES = [...TIPOS_DESTINO_CTA, "PROMOCION"];

/**
 * Las etiquetas de los cinco destinos, para el sobre de
 * `GET /admin/metricas-comerciales`. Mismo criterio que `ETIQUETA_DESTINO_CTA`
 * (de la que hereda las cuatro primeras) y que `GET /ordenes/estados`,
 * `/etiquetas/opciones` y `/campanias/opciones`: **es LA ÚNICA copia**, el
 * panel no tiene diccionario propio.
 *
 * La quinta acompaña a `PROMOCION` y sigue el estilo de las otras cuatro.
 */
export const ETIQUETA_DESTINO_COMERCIAL = {
  ...ETIQUETA_DESTINO_CTA,
  PROMOCION: "Los productos de la promoción",
};

/**
 * Las etiquetas de las dos superficies que emiten eventos. El vocabulario es
 * el que ya usan `docs/reglas/campanias.md` y la spec: `MODAL` es el cartel,
 * `BANNER` es el slide del carrusel.
 *
 * Existe por lo mismo que la anterior: el sobre ya emite `etapas[].etiqueta`,
 * así que dejar `MODAL`/`BANNER` crudas obligaría al panel a tener su propio
 * diccionario para la mitad del payload.
 */
export const ETIQUETA_ORIGEN_COMERCIAL = {
  MODAL: "Cartel",
  BANNER: "Slide del carrusel",
};

/**
 * Los orígenes con su etiqueta, en la forma que ya usan `listaDeTipos` y
 * `listaDeDestinosCta`. Devuelve objetos NUEVOS en cada llamada: el resultado
 * viaja a serialización y a pantallas que podrían mutarlo.
 */
export function listaDeOrigenesComerciales() {
  return ORIGENES_COMERCIALES.map((valor) => ({
    valor,
    etiqueta: ETIQUETA_ORIGEN_COMERCIAL[valor] ?? valor,
  }));
}

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
