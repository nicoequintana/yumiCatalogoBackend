import { MS_POR_DIA } from "./horarioArgentino.js";
import { ORIGENES_COMERCIALES, TIPOS_COMERCIALES } from "./eventosComerciales.js";

/**
 * La aritmética del endpoint de métricas comerciales, sin Prisma.
 *
 * Vive en `lib/` por el mismo motivo que `conflictosPromociones.js`: son
 * funciones puras que se prueban con arrays en la mano, y el controller
 * queda como la orquestación de las consultas. Todo lo que acá entra son
 * filas de `groupBy`; nada de esto carga eventos individuales.
 */

/**
 * Las dos etapas que se cuentan sobre los productos de la vitrina. Solo dos,
 * y no tres: `ORDEN_CREADA` no lleva `productId` (una orden abarca varios) y
 * atribuirla a una campaña es exactamente el alcance que se dejó afuera.
 */
export const ETAPAS_COMERCIALES = [
  { clave: "VISTAS", etiqueta: "Vistas de producto", tipo: "VISTA_PRODUCTO" },
  { clave: "CARRITO", etiqueta: "Agregados al carrito", tipo: "AGREGADO_CARRITO" },
];

/**
 * `clicks / impresiones` a cuatro decimales, o `null` cuando el número sería
 * mentira: sin impresiones no hay denominador, y más clicks que impresiones
 * (una impresión que no llegó y un click que sí) daría más de 100%. Misma
 * guarda que `calcularTasa` del Embudo.
 */
export function calcularTasaClicks(clicks, impresiones) {
  if (impresiones <= 0) return null;
  if (clicks > impresiones) return null;
  return Math.round((clicks / impresiones) * 10000) / 10000;
}

/**
 * `hasta` de una campaña es la medianoche argentina de su último día y el fin
 * es INCLUSIVO (ver `lib/campanias.js`): el rango de eventos tiene que llegar
 * al último milisegundo de ese día, no cortarse en su medianoche.
 */
export function finInclusivo(hasta) {
  return new Date(new Date(hasta).getTime() + MS_POR_DIA - 1);
}

/**
 * Una promoción no tiene `desde`/`hasta` propios. Su período es la unión de
 * sus programaciones HABILITADAS y de las campañas que la asocian: el mínimo
 * `desde` y el máximo `hasta` entre todas. Sin ninguna de las dos devuelve
 * `null` — no hay contra qué acotar, y una promoción así no emite slide, o
 * sea que no puede tener eventos: queda fuera de la lista.
 *
 * @param {{ programaciones: Array<{desde: Date, hasta: Date, habilitada: boolean}>,
 *           campanias: Array<{campania: {desde: Date, hasta: Date}}> }} promocion
 */
export function periodoDePromocion(promocion) {
  const rangos = [
    ...promocion.programaciones
      .filter((p) => p.habilitada)
      .map((p) => ({ desde: p.desde, hasta: p.hasta })),
    ...promocion.campanias.map((cp) => ({ desde: cp.campania.desde, hasta: cp.campania.hasta })),
  ];
  if (rangos.length === 0) return null;

  return {
    desde: new Date(Math.min(...rangos.map((r) => new Date(r.desde).getTime()))),
    hasta: new Date(Math.max(...rangos.map((r) => new Date(r.hasta).getTime()))),
  };
}

/** La forma de un ítem sin ningún evento: ceros EXPLÍCITOS en los dos orígenes. */
export function conteosVacios() {
  const porOrigen = () => Object.fromEntries(ORIGENES_COMERCIALES.map((o) => [o, 0]));
  return { impresiones: porOrigen(), clicks: porOrigen(), clicksPorDestino: [] };
}

/**
 * Reparte las filas de un `groupBy` por `[clave, tipo, origen, destino]` en
 * un mapa `id -> conteos`. Un `groupBy` omite los grupos vacíos, así que cada
 * ítem arranca de `conteosVacios()` para que un origen sin eventos sea un cero
 * y no una clave ausente. Las filas de tipos no comerciales se ignoran.
 *
 * @param {Array<{tipo: string, origen: string|null, destino: string|null, _count: {_all: number}}>} filas
 * @param {"campaniaId" | "promocionId"} clave
 * @returns {Map<number, ReturnType<typeof conteosVacios>>}
 */
export function repartirEventos(filas, clave) {
  const mapa = new Map();
  const destinos = new Map(); // id -> Map<destino, clicks>

  for (const fila of filas) {
    if (!TIPOS_COMERCIALES.includes(fila.tipo)) continue;
    const id = fila[clave];
    if (id === null || id === undefined) continue;

    if (!mapa.has(id)) {
      mapa.set(id, conteosVacios());
      destinos.set(id, new Map());
    }
    const conteos = mapa.get(id);
    const cantidad = fila._count?._all ?? 0;

    if (fila.tipo === "IMPRESION_COMERCIAL") {
      conteos.impresiones[fila.origen] = (conteos.impresiones[fila.origen] ?? 0) + cantidad;
    } else {
      conteos.clicks[fila.origen] = (conteos.clicks[fila.origen] ?? 0) + cantidad;
      const porDestino = destinos.get(id);
      porDestino.set(fila.destino, (porDestino.get(fila.destino) ?? 0) + cantidad);
    }
  }

  for (const [id, porDestino] of destinos) {
    mapa.get(id).clicksPorDestino = [...porDestino.entries()]
      .map(([destino, clicks]) => ({ destino, clicks }))
      // Clicks descendente, y desempate alfabético por destino para que dos
      // destinos empatados no salgan en distinto orden entre dos requests
      // (el orden de un `Map` sigue el de inserción, que depende del orden
      // de las filas del `groupBy`, no garantizado).
      .sort((a, b) => b.clicks - a.clicks || a.destino.localeCompare(b.destino));
  }

  return mapa;
}

/**
 * Suma las etapas por ítem a partir de un `groupBy` por `[productId, tipo]`
 * y del mapa `id -> Set<productId>` de cada vitrina. Un producto que está en
 * dos vitrinas suma en las dos: se CUENTA, no se reparte, porque una vista de
 * ese producto es una vista para cada campaña que lo exhibe.
 *
 * @param {Array<{productId: number|null, tipo: string, _count: {_all: number}}>} filas
 * @param {Map<string, Set<number>>} vitrinas
 * @returns {Map<string, Record<string, number>>}
 */
export function repartirEtapas(filas, vitrinas) {
  const mapa = new Map();
  for (const id of vitrinas.keys()) {
    mapa.set(id, Object.fromEntries(ETAPAS_COMERCIALES.map((e) => [e.clave, 0])));
  }

  const claveDeTipo = new Map(ETAPAS_COMERCIALES.map((e) => [e.tipo, e.clave]));

  for (const fila of filas) {
    const claveEtapa = claveDeTipo.get(fila.tipo);
    if (!claveEtapa || fila.productId === null || fila.productId === undefined) continue;
    const cantidad = fila._count?._all ?? 0;

    for (const [id, productos] of vitrinas) {
      if (productos.has(fila.productId)) {
        mapa.get(id)[claveEtapa] += cantidad;
      }
    }
  }

  return mapa;
}
