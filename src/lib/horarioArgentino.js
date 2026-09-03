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
 * ÚNICA definición de "día" del sistema: no hay copia en el frontend. La
 * hubo — `frontend/src/utils/periodo.js`, que construía las claves
 * `desde`/`hasta` con su propio desfase— y se eliminó: las pantallas de
 * analytics mandan `?dias=N` y el rango lo resuelve `parsearPeriodo` acá, así
 * que ya no hay dos calendarios que se puedan desincronizar.
 *
 * Los dos consumidores son `controllers/admin.controller.js`, que resuelve el
 * período pedido y agrupa las ventas por día, y `lib/plantillasEmail.js`, que
 * fecha el comprobante del cliente.
 */

/**
 * Argentina está en UTC-3 fijo: no aplica horario de verano desde 2009, así
 * que el desplazamiento es una constante y no hace falta una base de zonas
 * horarias para resolverlo.
 */
export const DESFASE_ARGENTINA_MS = -3 * 60 * 60 * 1000;

/**
 * Milisegundos de un día.
 *
 * Vive acá y no en cada controller por el mismo motivo que el desfase: es una
 * pieza de la definición de "día" del sistema. Estuvo escrita literal en tres
 * archivos a la vez (`admin`, `adminClientes` y `adminOperacion`), sin que
 * ninguno declarara ser espejo de los otros — la forma de duplicación que peor
 * envejece, porque nadie sabe que existe hasta que hay que cambiarla.
 */
export const MS_POR_DIA = 24 * 60 * 60 * 1000;

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

/** Formato de clave que este módulo acepta: día argentino, sin hora. */
const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Cuántos DÍAS ARGENTINOS faltan desde `ahora` hasta el día `clave`.
 *
 * Es el motor de los contadores de campaña ("Faltan 18 días para la Primavera").
 * Cuenta DÍAS, no diferencias de instantes: los dos extremos se llevan a su
 * medianoche argentina antes de restar. Sin eso, a las 21:00 del 20 —que en UTC
 * ya es el 21— el contador se adelantaría un día cada noche, justo en la franja
 * en la que más gente mira el sitio.
 *
 * El mismo día da **cero**, que es lo que permite decir "¡Es hoy!" en vez de
 * "falta 1 día". Una fecha ya pasada da un **negativo**: cero sería mentir, y
 * taparlo acá le sacaría al llamador la información para decidir qué mostrar.
 *
 * @param {string} clave - `"YYYY-MM-DD"`
 * @param {Date} [ahora]
 * @returns {number|null} null si la clave no tiene el formato esperado
 */
export function diasHastaClave(clave, ahora = new Date()) {
  if (typeof clave !== "string" || !SOLO_FECHA.test(clave)) return null;

  const objetivo = inicioDelDiaArgentino(clave);
  if (objetivo === null) return null;

  const hoy = inicioDelDiaArgentino(claveDiaArgentino(ahora));
  return Math.round((objetivo.getTime() - hoy.getTime()) / MS_POR_DIA);
}
