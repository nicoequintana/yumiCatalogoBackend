/**
 * La hora de Argentina, en un solo lugar.
 *
 * El contenedor corre en UTC y el negocio vive en Buenos Aires. Un pedido de
 * las 21:30 de acá es 00:30 UTC del día siguiente, así que cualquier cosa que
 * lea la fecha con la zona del servidor —o con `toISOString()`— le pone el día
 * equivocado justo a las compras de la noche, que es cuando más se vende.
 *
 * Nació en `plantillasEmail.js` (para no fecharle mal el comprobante a un
 * cliente) y salió a `lib/` cuando apareció el segundo consumidor: la analytics
 * del admin, que agrupa las ventas por día. Un tercer lugar donde volver a
 * escribir el `-3` sería la regresión que advierte "Módulos compartidos" del
 * CLAUDE.md: dos definiciones de "día" que se pueden desincronizar sin que nada
 * falle.
 *
 * ESPEJO MANUAL de `frontend/src/utils/periodo.js`, que es quien CONSTRUYE las
 * claves `desde`/`hasta` que este módulo INTERPRETA. Los dos repos se publican
 * por separado, así que no hay forma de compartir el módulo ni de compararlos
 * en la misma corrida de tests: la única defensa es que los dos lados tengan la
 * misma tabla de casos (`horarioArgentino.test.js` ↔ `periodo.test.js`). Si
 * divergen, el frontend pide una ventana y el backend contesta por otra, sin
 * ningún error — es la misma sincronización manual que
 * `lib/slug.js` ↔ `utils/slug.js` y `lib/precios.js` ↔ `utils/precios.js`.
 */

/**
 * Argentina está en UTC-3 fijo: no aplica horario de verano desde 2009, así
 * que el desplazamiento es una constante y no hace falta una base de zonas
 * horarias para resolverlo.
 */
export const DESFASE_ARGENTINA_MS = -3 * 60 * 60 * 1000;

/**
 * Desplaza un instante a la hora de Argentina para poder leer sus partes con
 * los getters `getUTC*`.
 *
 * NO se usa `Intl.DateTimeFormat`, por el mismo motivo que `formatearMonto` no
 * usa `Intl.NumberFormat`: la salida depende de la versión de ICU del runtime y
 * un test que la afirme pasa en una máquina y falla en otra.
 *
 * @param {Date|string|number|null|undefined} valor
 * @returns {Date|null} null si el valor falta o no es una fecha legible
 */
export function enHorarioArgentino(valor) {
  if (valor === null || valor === undefined) return null;
  const fecha = valor instanceof Date ? valor : new Date(valor);
  const instante = fecha.getTime();
  if (Number.isNaN(instante)) return null;
  return new Date(instante + DESFASE_ARGENTINA_MS);
}

/**
 * Instante → `"YYYY-MM-DD"` del día ARGENTINO al que pertenece.
 *
 * Es la clave con la que se agrupan las ventas por día. Con
 * `toISOString().slice(0, 10)` a secas, una orden de las 21:00 ART caía en el
 * punto del día SIGUIENTE de la serie temporal: el rótulo quedaba bien y el
 * número atrás estaba corrido, que es la peor combinación posible porque nada
 * la delata.
 *
 * @param {Date|string|number} valor
 * @returns {string}
 */
export function claveDiaArgentino(valor) {
  return enHorarioArgentino(valor).toISOString().slice(0, 10);
}

/**
 * `"YYYY-MM-DD"` (día argentino) → el instante UTC de SU medianoche.
 *
 * Es la contraparte exacta de `claveDiaArgentino` y existe porque los límites
 * del período se comparan contra `Orden.createdAt`, que la base guarda en UTC:
 * tienen que seguir siendo instantes UTC correctos, solo que los que
 * corresponden a la medianoche de Buenos Aires y no a la de Greenwich. Sin
 * esto, "últimos 30 días" arrancaba y terminaba a las 21:00 hora local.
 *
 * @param {string} clave - `"YYYY-MM-DD"`
 * @returns {Date|null} null si la clave no es una fecha legible
 */
export function inicioDelDiaArgentino(clave) {
  const medianoche = new Date(`${clave}T00:00:00.000Z`);
  if (Number.isNaN(medianoche.getTime())) return null;
  // Se RESTA el desfase (que es negativo), o sea se suman 3 horas: la
  // medianoche del 15 en Buenos Aires es el 15 a las 03:00 UTC.
  return new Date(medianoche.getTime() - DESFASE_ARGENTINA_MS);
}
