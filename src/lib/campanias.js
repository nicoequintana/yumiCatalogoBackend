/**
 * Fuente única de verdad de "¿esta campaña está activa ahora?".
 *
 * La lista canónica de tipos y estados vive en `prisma/schema.prisma`
 * (`Campania.tipo` y `Campania.estado` son `VarChar`, no enums de base — SQL
 * Server vía Prisma no los tiene). Ese comentario del schema no compila nada:
 * lo que efectivamente valida es este módulo, mismo criterio que
 * `estadosOrden.js`.
 *
 * El estado de una campaña son DOS ejes que se multiplican, y confundirlos es
 * el error que este archivo existe para impedir:
 *
 *   - el ADMINISTRATIVO (`estado`), que el admin elige a mano y se persiste;
 *   - el TEMPORAL (`PROGRAMADA`/`ACTIVA`/`FINALIZADA`), que sale de las fechas
 *     y NO se persiste nunca.
 *
 * El temporal no se guarda por el mismo motivo que `estadoDePrecio` tampoco se
 * guarda: una columna con el estado se desincroniza de las fechas sola, al
 * pasar la medianoche, sin ninguna escritura que la delate. Una campaña
 * "ACTIVA" en la base y vencida en el calendario no da error en ningún lado —
 * simplemente le sigue mostrando el Doodle de Navidad a alguien en marzo.
 *
 * Nadie más resuelve esto: ni el navbar, ni el modal, ni el mapper, ni el
 * panel. Todos preguntan acá.
 */

import { MS_POR_DIA } from "./horarioArgentino.js";

/**
 * Los tipos de campaña. Son una clasificación para el admin, no una rama de
 * lógica: agregar uno nuevo no debería obligar a tocar ningún `if`.
 */
export const TIPOS_CAMPANIA = [
  "ESTACIONAL",
  "EVENTO_COMERCIAL",
  "FECHA_ESPECIAL",
  "PROMOCIONAL",
  "INSTITUCIONAL",
  "OTRO",
];

/**
 * El eje ADMINISTRATIVO: lo que el admin decidió a mano.
 *
 * `BORRADOR` es el estado de una campaña que todavía se está armando, y no
 * produce efectos aunque caiga dentro de su período. `DESHABILITADA` es el OFF
 * manual de una campaña que ya estuvo lista: los dos apagan, pero dicen cosas
 * distintas y por eso son dos y no uno.
 */
export const ESTADOS_CAMPANIA = ["BORRADOR", "HABILITADA", "DESHABILITADA"];

/**
 * El eje TEMPORAL: lo que dicen las fechas. DERIVADO, nunca persistido.
 *
 * Ningún valor coincide con los del eje administrativo, y eso es deliberado:
 * si compartieran uno, un error de tipeo podría cruzar las dos dimensiones sin
 * que nada fallara.
 */
export const ESTADOS_TEMPORALES = ["PROGRAMADA", "ACTIVA", "FINALIZADA"];

/**
 * Etiquetas legibles de los tipos.
 *
 * **Es LA ÚNICA copia**, igual que las de estado: viajan por
 * `GET /campanias/opciones` y el panel no tiene diccionario propio. Estuvo un
 * rato sin ningún consumidor mientras el formulario usaba una copia hecha a
 * mano — o sea, la casa única vacía y el espejo en uso. Hay un test que afirma
 * que todo tipo tiene su etiqueta y que no sobra ninguna.
 */
export const ETIQUETA_TIPO = {
  ESTACIONAL: "Estacional",
  EVENTO_COMERCIAL: "Evento comercial",
  FECHA_ESPECIAL: "Fecha especial",
  PROMOCIONAL: "Promocional",
  INSTITUCIONAL: "Institucional",
  OTRO: "Otro",
};

/**
 * Etiquetas del eje administrativo.
 *
 * Como en `estadosOrden.js`, este diccionario es LA ÚNICA copia: las etiquetas
 * viajan en la respuesta y el frontend no tiene la suya. Agregar un estado se
 * toca en un solo lugar.
 */
export const ETIQUETA_ESTADO_CAMPANIA = {
  BORRADOR: "Borrador",
  HABILITADA: "Habilitada",
  DESHABILITADA: "Deshabilitada",
};

/** Etiquetas del eje temporal. */
export const ETIQUETA_ESTADO_TEMPORAL = {
  PROGRAMADA: "Programada",
  ACTIVA: "Activa",
  FINALIZADA: "Finalizada",
};

/**
 * A dónde puede llevar el botón del modal — la INTENCIÓN, no la ruta.
 *
 * La columna guardaba antes el CÓMO: una ruta escrita a mano y validada contra
 * una whitelist de regex sincronizada con `frontend/src/App.jsx`. Eso tenía tres
 * modos de falla mudos: la ruta de categoría no verificaba que la categoría
 * existiera ni sobrevivía a un rename, `/coleccion?etiqueta=x` pasaba la
 * validación aunque `Coleccion.jsx` nunca lea `etiqueta` (el botón caía en el
 * catálogo entero), y quien opera el panel tenía que tipear una URL.
 *
 * Guardando el QUÉ, la ruta la arma el backend AL LEER: siempre apunta a algo
 * que existe hoy, y un renombre de categoría se refleja solo.
 */
export const TIPOS_DESTINO_CTA = ["CAMPANIA", "CATALOGO", "CATEGORIA", "PRODUCTO"];

/**
 * Etiquetas de los destinos. Como las de tipo y estado, **es LA ÚNICA copia**:
 * viajan por `GET /campanias/opciones` y el panel no tiene diccionario propio.
 * Hay un test que afirma que todo destino tiene su etiqueta y que no sobra
 * ninguna.
 */
export const ETIQUETA_DESTINO_CTA = {
  CAMPANIA: "Los productos de la campaña",
  CATALOGO: "Todo el catálogo",
  CATEGORIA: "Una categoría",
  PRODUCTO: "Un producto",
};

/**
 * El texto del botón cuando el admin no escribió ninguno.
 *
 * Vive acá y no en el formulario porque el placeholder del editor no puede ser
 * una copia manual de este string: es la regla 1 de la metodología —el dato
 * derivado viaja en la respuesta—, y por eso `GET /campanias/opciones` lo emite.
 */
export const CTA_TEXTO_POR_DEFECTO = "Ver más";

/*
 * ⚠️ ACÁ VIVÍA `COLORES_SLIDE` — la lista cerrada de fondos del slide — con su
 * default y el armador del diccionario de `GET /campanias/opciones`.
 *
 * Se fueron los tres el 06/09/2026, cuando el slide entero pasó a ser el
 * enlace: sin botón adentro, el molde sin arte va SIEMPRE en el color de marca
 * y no hay nada que elegir. Las columnas `Campania.bannerColor` y
 * `Promocion.bannerColor` siguen en la base, INERTES —nadie las lee ni las
 * escribe—, mismo criterio que `Foto.driveFileId`.
 *
 * El guard de la ausencia vive en `campanias.test.js`: reintroducir la lista
 * sin un consumidor real falla mudo.
 */

/**
 * Los tipos con su etiqueta, en la forma que consume el `<select>` del panel.
 *
 * Existe por el mismo motivo que `listaDeEstados` en `estadosOrden.js`: sin
 * este endpoint el frontend copia la lista a mano, y agregar un tipo pasa a
 * tocarse en dos lugares con un modo de falla MUDO — el backend lo acepta y el
 * panel no lo ofrece, sin que nada falle.
 *
 * Devuelve objetos NUEVOS en cada llamada: el resultado viaja a serialización y
 * a pantallas que podrían mutarlo.
 */
export function listaDeTipos() {
  return TIPOS_CAMPANIA.map((valor) => ({ valor, etiqueta: ETIQUETA_TIPO[valor] ?? valor }));
}

/** Ídem para el eje administrativo. */
export function listaDeEstadosCampania() {
  return ESTADOS_CAMPANIA.map((valor) => ({
    valor,
    etiqueta: ETIQUETA_ESTADO_CAMPANIA[valor] ?? valor,
  }));
}

/** Ídem para los destinos del CTA. */
export function listaDeDestinosCta() {
  return TIPOS_DESTINO_CTA.map((valor) => ({
    valor,
    etiqueta: ETIQUETA_DESTINO_CTA[valor] ?? valor,
  }));
}

/**
 * El instante en que una campaña deja de estar vigente: la medianoche
 * siguiente al día de `hasta`.
 *
 * `desde` y `hasta` se guardan como la medianoche ARGENTINA de su día (los
 * escribe `inicioDelDiaArgentino`). Que el fin sea EXCLUSIVO y valga la
 * medianoche siguiente es lo que hace que una campaña que termina el 20 valga
 * durante todo el 20 — incluidas las 21:00, que en UTC ya son el 21 y son la
 * franja en la que más se vende.
 *
 * @param {Date|string|number} hasta
 * @returns {number} instante en ms
 */
function finExclusivo(hasta) {
  return new Date(hasta).getTime() + MS_POR_DIA;
}

/**
 * Dónde cae una campaña respecto de su propio período, sin mirar el estado
 * administrativo.
 *
 * Sirve sola para el badge del calendario ("esta terminó", "esta arranca el
 * mes que viene"). Para decidir si produce efectos hay que usar
 * `resolverEstadoCampania`: una campaña puede estar `ACTIVA` acá y apagada por
 * el admin.
 *
 * @param {{desde: Date|string, hasta: Date|string}} campania
 * @param {Date} [ahora]
 * @returns {"PROGRAMADA"|"ACTIVA"|"FINALIZADA"}
 */
export function estadoTemporal(campania, ahora = new Date()) {
  const instante = ahora.getTime();

  if (instante < new Date(campania.desde).getTime()) return "PROGRAMADA";
  if (instante < finExclusivo(campania.hasta)) return "ACTIVA";
  return "FINALIZADA";
}

/**
 * El veredicto completo: los dos ejes y su producto.
 *
 * `activa` es la única propiedad que decide si la campaña produce efectos
 * —Doodle, modal, CTA, y en su momento las promociones asociadas—. Exige las
 * dos mitades:
 *
 *     activa = estado HABILITADA  Y  hoy dentro del período
 *
 * De ahí salen las dos reglas que pidió el pedido original y que los tests
 * cubren: el OFF manual apaga una campaña que está en fecha, y el ON manual NO
 * fuerza una activación fuera de fecha.
 *
 * Las etiquetas se emiten desde acá para que ninguna pantalla arme su propio
 * diccionario; un estado desconocido sale como su clave —feo pero legible— en
 * vez de `undefined`, mismo criterio que `etiquetaDeEstado` en `estadosOrden.js`.
 *
 * @param {{estado: string, desde: Date|string, hasta: Date|string}} campania
 * @param {Date} [ahora]
 */
export function resolverEstadoCampania(campania, ahora = new Date()) {
  const manual = campania.estado;
  const temporal = estadoTemporal(campania, ahora);

  return {
    manual,
    temporal,
    activa: manual === "HABILITADA" && temporal === "ACTIVA",
    etiquetaEstado: ETIQUETA_ESTADO_CAMPANIA[manual] ?? manual,
    etiquetaTemporal: ETIQUETA_ESTADO_TEMPORAL[temporal] ?? temporal,
  };
}

/**
 * De varias campañas candidatas, la que gana un recurso visual que solo admite
 * una a la vez.
 *
 * Las campañas se pueden superponer a propósito, pero el logo es uno solo. El
 * llamador filtra QUÉ campañas compiten (las activas que además tienen Doodle,
 * por ejemplo) y esta función resuelve CUÁL de ellas manda.
 *
 * El desempate por `id` descendente no es decorativo: sin él, dos campañas con
 * la misma prioridad podrían devolver Doodles distintos en dos requests del
 * mismo instante, y el logo del sitio parpadearía entre dos imágenes según qué
 * orden le devolvió la base. Es el mismo criterio que el desempate por `id` de
 * los 25 criterios de `ORDENES_LISTADO`.
 *
 * ⚠️ NO usar esta prioridad para resolver conflictos de descuentos entre
 * promociones: esos se resuelven a mano y por producto, con sus propias reglas.
 *
 * @param {Array<{id: number, prioridad: number}>} [campanias]
 * @returns {object|null} null —nunca undefined— si no hay candidatas
 */
export function elegirPorPrioridad(campanias) {
  if (!campanias?.length) return null;

  return campanias.reduce((mejor, actual) => {
    if (actual.prioridad !== mejor.prioridad) {
      return actual.prioridad > mejor.prioridad ? actual : mejor;
    }
    return actual.id > mejor.id ? actual : mejor;
  });
}
