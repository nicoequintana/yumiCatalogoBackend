import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const campaniaFindManyMock = vi.fn();
const promocionFindManyMock = vi.fn();
const eventoGroupByMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    campania: { findMany: (...a) => campaniaFindManyMock(...a) },
    promocion: { findMany: (...a) => promocionFindManyMock(...a) },
    eventoTrafico: { groupBy: (...a) => eventoGroupByMock(...a) },
  },
}));

const { metricasComerciales, MAX_ITEMS_METRICAS } = await import(
  "./metricasComerciales.controller.js"
);

const dia = (s) => new Date(`${s}T03:00:00.000Z`); // medianoche argentina

function buildReqRes(query = {}) {
  const req = { query, usuario: { id: 1 } };
  const res = {
    body: null,
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

// `eventoTrafico.groupBy` se llama CUATRO veces y en un orden fijo (ver el
// controller): arranque global, eventos por campaña, eventos por promoción, y
// después una cuarta para las etapas. El mock responde según el `by`.
function programarGroupBy({ arranque = [], porCampania = [], porPromocion = [], etapas = [] }) {
  eventoGroupByMock.mockImplementation(async ({ by, _min }) => {
    if (_min) return arranque;
    if (by.includes("campaniaId")) return porCampania;
    if (by.includes("promocionId")) return porPromocion;
    if (by.includes("productId")) return etapas;
    throw new Error(`groupBy inesperado: ${JSON.stringify(by)}`);
  });
}

/**
 * El otro mock: en vez de responder filas ya agregadas, SIMULA la base sobre
 * una lista de eventos crudos aplicando el `where` que arma el controller.
 * Es lo que permite afirmar "este evento no se cuenta" en vez de solo afirmar
 * la forma del `where` — que es justo donde vivía el bug del rango único.
 */
function simularGroupBy(eventos) {
  const enRango = (fecha, rango) => fecha >= rango.gte && fecha <= rango.lte;

  eventoGroupByMock.mockImplementation(async ({ by, where, _min }) => {
    if (_min) {
      const porTipo = new Map();
      for (const e of eventos) {
        if (!["IMPRESION_COMERCIAL", "CLICK_COMERCIAL"].includes(e.tipo)) continue;
        const previo = porTipo.get(e.tipo);
        if (!previo || e.createdAt < previo) porTipo.set(e.tipo, e.createdAt);
      }
      return [...porTipo].map(([tipo, createdAt]) => ({ tipo, _min: { createdAt } }));
    }

    const filtrados = eventos.filter((e) => {
      if (where.tipo && !where.tipo.in.includes(e.tipo)) return false;
      if (where.OR) {
        return where.OR.some((rama) =>
          Object.entries(rama).every(([campo, valor]) =>
            campo === "createdAt" ? enRango(e.createdAt, valor) : e[campo] === valor,
          ),
        );
      }
      if (where.productId && !where.productId.in.includes(e.productId)) return false;
      if (where.createdAt && !enRango(e.createdAt, where.createdAt)) return false;
      return true;
    });

    const grupos = new Map();
    for (const e of filtrados) {
      const fila = Object.fromEntries(by.map((c) => [c, e[c] ?? null]));
      const clave = JSON.stringify(by.map((c) => fila[c]));
      if (!grupos.has(clave)) grupos.set(clave, { ...fila, _count: { _all: 0 } });
      grupos.get(clave)._count._all += 1;
    }
    return [...grupos.values()];
  });
}

const CAMPANIA = {
  id: 1054,
  nombre: "Primavera",
  estado: "HABILITADA",
  desde: dia("2026-09-06"),
  hasta: dia("2026-09-16"),
  productos: [{ productId: 10 }, { productId: 11 }],
};

beforeEach(() => {
  campaniaFindManyMock.mockReset();
  promocionFindManyMock.mockReset();
  eventoGroupByMock.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T15:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("metricasComerciales", () => {
  it("arma un ítem de campaña con su período, sus conteos, tasas y etapas", async () => {
    campaniaFindManyMock.mockResolvedValue([CAMPANIA]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({
      arranque: [{ tipo: "IMPRESION_COMERCIAL", _min: { createdAt: dia("2026-09-08") } }],
      porCampania: [
        { campaniaId: 1054, tipo: "IMPRESION_COMERCIAL", origen: "MODAL", destino: null, _count: { _all: 1240 } },
        { campaniaId: 1054, tipo: "IMPRESION_COMERCIAL", origen: "BANNER", destino: null, _count: { _all: 3810 } },
        { campaniaId: 1054, tipo: "CLICK_COMERCIAL", origen: "MODAL", destino: "CAMPANIA", _count: { _all: 41 } },
        { campaniaId: 1054, tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "CAMPANIA", _count: { _all: 127 } },
      ],
      etapas: [
        { productId: 10, tipo: "VISTA_PRODUCTO", _count: { _all: 300 } },
        { productId: 11, tipo: "VISTA_PRODUCTO", _count: { _all: 212 } },
        { productId: 10, tipo: "AGREGADO_CARRITO", _count: { _all: 38 } },
      ],
    });
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.body.registraDesde).toBe("2026-09-08");
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toEqual({
      tipo: "CAMPANIA",
      id: 1054,
      nombre: "Primavera",
      estado: "HABILITADA",
      estadoTemporal: "ACTIVA",
      periodo: { desde: "2026-09-06", hasta: "2026-09-16" },
      // Empezó el 06, la medición el 08: está subcontada.
      subregistrada: true,
      impresiones: { MODAL: 1240, BANNER: 3810 },
      clicks: { MODAL: 41, BANNER: 127 },
      tasaClicks: { MODAL: 0.0331, BANNER: 0.0333 },
      clicksPorDestino: [
        { destino: "CAMPANIA", etiqueta: "Los productos de la campaña", clicks: 168 },
      ],
      etapas: [
        { clave: "VISTAS", etiqueta: "Vistas de producto", cantidad: 512 },
        { clave: "CARRITO", etiqueta: "Agregados al carrito", cantidad: 38 },
      ],
    });
  });

  it("sin ningún evento comercial, registraDesde es null y todo ítem es subregistrado", async () => {
    campaniaFindManyMock.mockResolvedValue([CAMPANIA]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({ arranque: [] });
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.registraDesde).toBeNull();
    expect(res.body.items[0].subregistrada).toBe(true);
    expect(res.body.items[0].impresiones).toEqual({ MODAL: 0, BANNER: 0 });
    expect(res.body.items[0].tasaClicks).toEqual({ MODAL: null, BANNER: null });
  });

  it("una campaña que empezó DESPUÉS del arranque no es subregistrada", async () => {
    campaniaFindManyMock.mockResolvedValue([{ ...CAMPANIA, desde: dia("2026-09-09") }]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({
      arranque: [{ tipo: "CLICK_COMERCIAL", _min: { createdAt: dia("2026-09-08") } }],
    });
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.items[0].subregistrada).toBe(false);
  });

  it("los groupBy de eventos acotan al período de CADA ítem, no al rango total", async () => {
    campaniaFindManyMock.mockResolvedValue([
      CAMPANIA,
      { ...CAMPANIA, id: 2, nombre: "Otra", desde: dia("2026-08-01"), hasta: dia("2026-08-10") },
    ]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    const llamadaCampania = eventoGroupByMock.mock.calls.find(([arg]) => arg.by?.includes("campaniaId"))[0];
    expect(llamadaCampania.by).toEqual(["campaniaId", "tipo", "origen", "destino"]);
    expect(llamadaCampania._count).toEqual({ _all: true });
    // Sigue siendo UNA sola consulta: un `OR` con el rango propio de cada
    // ítem, no un query por campaña. Nada de `where.createdAt` en la raíz.
    expect(llamadaCampania.where.createdAt).toBeUndefined();
    expect(llamadaCampania.where.campaniaId).toBeUndefined();
    expect(llamadaCampania.where.tipo).toEqual({ in: ["IMPRESION_COMERCIAL", "CLICK_COMERCIAL"] });
    expect(llamadaCampania.where.OR).toHaveLength(2);
    expect(llamadaCampania.where.OR[0].campaniaId).toBe(1054);
    expect(llamadaCampania.where.OR[0].createdAt.gte.toISOString()).toBe("2026-09-06T03:00:00.000Z");
    // Fin INCLUSIVO: el último milisegundo del día de `hasta`.
    expect(llamadaCampania.where.OR[0].createdAt.lte.toISOString()).toBe("2026-09-17T02:59:59.999Z");
    expect(llamadaCampania.where.OR[1].campaniaId).toBe(2);
    expect(llamadaCampania.where.OR[1].createdAt.gte.toISOString()).toBe("2026-08-01T03:00:00.000Z");
    expect(llamadaCampania.where.OR[1].createdAt.lte.toISOString()).toBe("2026-08-11T02:59:59.999Z");
  });

  // El test que fija toda la corrección del rango por ítem. El mock SIMULA la
  // base: aplica el `where` sobre eventos crudos. Con un rango único (el `min`
  // de todos los `desde` al `max` de todos los `hasta`) el evento posteado hoy
  // contra la campaña de enero caía adentro y se contaba — y con eso se caía
  // el argumento por el que la escritura no valida vigencia: un anónimo podía
  // inflar los números de cualquier campaña terminada.
  it("un evento posteado HOY contra una campaña de enero no entra en sus conteos", async () => {
    const enero = { ...CAMPANIA, id: 2, nombre: "Enero", desde: dia("2026-01-05"), hasta: dia("2026-01-20") };
    campaniaFindManyMock.mockResolvedValue([CAMPANIA, enero]);
    promocionFindManyMock.mockResolvedValue([]);
    simularGroupBy([
      // Legítimo: dentro del período de Enero.
      { campaniaId: 2, tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "CAMPANIA", createdAt: dia("2026-01-10") },
      // Fabricado hoy contra una campaña terminada hace ocho meses.
      { campaniaId: 2, tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "CAMPANIA", createdAt: new Date("2026-09-10T14:00:00.000Z") },
      // De la campaña vigente, dentro de su período: este sí cuenta.
      { campaniaId: 1054, tipo: "IMPRESION_COMERCIAL", origen: "MODAL", destino: null, createdAt: new Date("2026-09-10T14:00:00.000Z") },
    ]);
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    const porNombre = Object.fromEntries(res.body.items.map((i) => [i.nombre, i]));
    expect(porNombre.Enero.clicks).toEqual({ MODAL: 0, BANNER: 1 });
    expect(porNombre.Primavera.impresiones).toEqual({ MODAL: 1, BANNER: 0 });
  });

  // ⚠️ `OR: []` en Prisma NO filtra nada: trae la tabla entera. El early
  // return cubre "cero ítems", pero un lado puede quedar vacío con el otro
  // lleno (acá: solo promociones), y ahí el `OR` de campañas sería el vacío.
  it("con solo promociones NO corre el groupBy de campañas (un OR vacío no filtraría nada)", async () => {
    campaniaFindManyMock.mockResolvedValue([]);
    promocionFindManyMock.mockResolvedValue([
      {
        id: 7, nombre: "Semana del hogar", activa: true, items: [{ productId: 20 }],
        programaciones: [{ desde: dia("2026-09-08"), hasta: dia("2026-09-14"), habilitada: true }],
        campanias: [],
      },
    ]);
    simularGroupBy([
      { promocionId: 7, tipo: "IMPRESION_COMERCIAL", origen: "BANNER", destino: null, createdAt: dia("2026-09-09") },
      // Fuera del período de la promoción: no cuenta.
      { promocionId: 7, tipo: "IMPRESION_COMERCIAL", origen: "BANNER", destino: null, createdAt: dia("2026-10-01") },
    ]);
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(eventoGroupByMock.mock.calls.some(([arg]) => arg.by?.includes("campaniaId"))).toBe(false);
    expect(res.body.items[0].impresiones).toEqual({ MODAL: 0, BANNER: 1 });
  });

  it("las etapas se acotan a los productos de las vitrinas del lote y al RANGO TOTAL", async () => {
    campaniaFindManyMock.mockResolvedValue([
      CAMPANIA,
      { ...CAMPANIA, id: 2, nombre: "Otra", desde: dia("2026-08-01"), hasta: dia("2026-08-10") },
    ]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    const llamadaEtapas = eventoGroupByMock.mock.calls.find(([arg]) => arg.by?.includes("productId"))[0];
    expect(llamadaEtapas.by).toEqual(["productId", "tipo"]);
    expect(llamadaEtapas.where.productId).toEqual({ in: [10, 11] });
    expect(llamadaEtapas.where.tipo).toEqual({ in: ["VISTA_PRODUCTO", "AGREGADO_CARRITO"] });
    // Rango TOTAL, y no el de cada ítem: agrupan por `productId`, así que un
    // `OR` de rangos distintos no diría de qué rama vino cada conteo.
    expect(llamadaEtapas.where.createdAt.gte.toISOString()).toBe("2026-08-01T03:00:00.000Z");
    expect(llamadaEtapas.where.createdAt.lte.toISOString()).toBe("2026-09-17T02:59:59.999Z");
  });

  it("el sobre DECLARA el rango sobre el que se contaron las etapas", async () => {
    campaniaFindManyMock.mockResolvedValue([
      CAMPANIA,
      { ...CAMPANIA, id: 2, nombre: "Enero", desde: dia("2026-01-05"), hasta: dia("2026-01-20") },
    ]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    // Es el rango TOTAL, distinto del `periodo` del ítem viejo: sin declararlo,
    // Enero reporta nueve meses de vistas de sus productos al lado de un
    // período de quince días, y nada en el sobre lo dice.
    expect(res.body.etapasEnRango).toEqual({ desde: "2026-01-05", hasta: "2026-09-16" });
    expect(res.body.items.find((i) => i.nombre === "Enero").periodo).toEqual({
      desde: "2026-01-05",
      hasta: "2026-01-20",
    });
  });

  it("sin ítems, etapasEnRango es null y la clave viaja igual", async () => {
    campaniaFindManyMock.mockResolvedValue([]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.items).toEqual([]);
    expect(res.body).toHaveProperty("etapasEnRango", null);
  });

  it("el sobre emite las etiquetas de origen, que el panel no tiene", async () => {
    campaniaFindManyMock.mockResolvedValue([CAMPANIA]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.origenes).toEqual([
      { valor: "MODAL", etiqueta: "Cartel" },
      { valor: "BANNER", etiqueta: "Slide del carrusel" },
    ]);
  });

  it("las etapas se agrupan en el rango TOTAL del lote, no en el de cada ítem (imprecisión asumida)", async () => {
    campaniaFindManyMock.mockResolvedValue([CAMPANIA]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({
      etapas: [{ productId: 10, tipo: "VISTA_PRODUCTO", _count: { _all: 5 } }],
    });
    // La implementación agrupa las etapas por [productId, tipo] SIN fecha
    // (no se puede filtrar por el período de cada ítem en un solo groupBy),
    // así que acota el `where.createdAt` al rango total y confía en que las
    // etapas de un producto son de la vitrina que lo exhibe. Ver la nota del
    // controller sobre esta imprecisión asumida.
    const { req, res, next } = buildReqRes();
    await metricasComerciales(req, res, next);
    expect(res.body.items[0].etapas[0].cantidad).toBe(5);
  });

  it("una promoción arma su período con sus programaciones y tiene destino PROMOCION", async () => {
    campaniaFindManyMock.mockResolvedValue([]);
    promocionFindManyMock.mockResolvedValue([
      {
        id: 7,
        nombre: "Semana del hogar",
        activa: true,
        items: [{ productId: 20 }],
        programaciones: [{ desde: dia("2026-09-08"), hasta: dia("2026-09-14"), habilitada: true }],
        campanias: [],
      },
    ]);
    programarGroupBy({
      arranque: [{ tipo: "IMPRESION_COMERCIAL", _min: { createdAt: dia("2026-09-01") } }],
      porPromocion: [
        { promocionId: 7, tipo: "IMPRESION_COMERCIAL", origen: "BANNER", destino: null, _count: { _all: 100 } },
        { promocionId: 7, tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "PROMOCION", _count: { _all: 9 } },
      ],
    });
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.items[0]).toMatchObject({
      tipo: "PROMOCION",
      id: 7,
      activa: true,
      estadoTemporal: "ACTIVA",
      periodo: { desde: "2026-09-08", hasta: "2026-09-14" },
      subregistrada: false,
      impresiones: { MODAL: 0, BANNER: 100 },
      clicksPorDestino: [
        { destino: "PROMOCION", etiqueta: "Los productos de la promoción", clicks: 9 },
      ],
    });
  });

  // Una promoción asociada a una campaña NO entra al carrusel
  // (`slidesDePromociones` la excluye con `campanias: { none: {} }`), así que
  // no tiene ninguna superficie y no puede generar un solo evento. Antes
  // entraba a la lista igual —`periodoDePromocion` le daba período con las
  // campañas asociadas— y salía con impresiones y clicks en cero ESTRUCTURAL
  // más las etapas de los productos de su campaña: el mismo número dibujado
  // dos veces. Una fila donde ningún dato es propio es una afirmación falsa.
  it("una promoción asociada a una campaña NO aparece: no tiene superficie propia", async () => {
    campaniaFindManyMock.mockResolvedValue([]);
    promocionFindManyMock.mockResolvedValue([
      {
        id: 9,
        nombre: "La de Navidad",
        activa: true,
        items: [{ productId: 30 }],
        programaciones: [],
        campanias: [{ campania: { desde: dia("2026-12-01"), hasta: dia("2026-12-24") } }],
      },
    ]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.items).toEqual([]);
  });

  it("una campaña en BORRADOR emite su estado administrativo tal cual", async () => {
    campaniaFindManyMock.mockResolvedValue([{ ...CAMPANIA, estado: "BORRADOR" }]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    // Fechas que cubren hoy pero nunca se publicó: estadoTemporal la marca
    // ACTIVA igual (es derivado, no sabe de BORRADOR), y por eso el endpoint
    // tiene que emitir el estado administrativo aparte para que el admin
    // distinga "corriendo sin verse" de "nunca salió al aire".
    expect(res.body.items[0].estado).toBe("BORRADOR");
    expect(res.body.items[0].estadoTemporal).toBe("ACTIVA");
  });

  it("una promoción sin programaciones ni campañas NO aparece", async () => {
    campaniaFindManyMock.mockResolvedValue([]);
    promocionFindManyMock.mockResolvedValue([
      { id: 8, nombre: "Suelta", activa: true, items: [], programaciones: [], campanias: [] },
    ]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.items).toEqual([]);
  });

  it("?estado= filtra por el eje temporal", async () => {
    campaniaFindManyMock.mockResolvedValue([
      CAMPANIA, // ACTIVA el 10/09
      { ...CAMPANIA, id: 2, nombre: "Vieja", desde: dia("2026-08-01"), hasta: dia("2026-08-10") }, // FINALIZADA
      { ...CAMPANIA, id: 3, nombre: "Futura", desde: dia("2026-12-01"), hasta: dia("2026-12-24") }, // PROGRAMADA
    ]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});

    const { req, res, next } = buildReqRes({ estado: "FINALIZADA" });
    await metricasComerciales(req, res, next);

    expect(res.body.items.map((i) => i.nombre)).toEqual(["Vieja"]);
  });

  it("un ?estado= desconocido no filtra (misma política que el resto de los filtros)", async () => {
    campaniaFindManyMock.mockResolvedValue([CAMPANIA]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes({ estado: "BANANA" });

    await metricasComerciales(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.body.items).toHaveLength(1);
  });

  it("pide como máximo MAX_ITEMS_METRICAS de cada uno, las más recientes primero", async () => {
    campaniaFindManyMock.mockResolvedValue([]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(MAX_ITEMS_METRICAS).toBe(50);
    expect(campaniaFindManyMock.mock.calls[0][0]).toMatchObject({
      orderBy: { desde: "desc" },
      take: 50,
    });
    expect(promocionFindManyMock.mock.calls[0][0]).toMatchObject({
      orderBy: { id: "desc" },
      take: 50,
    });
  });

  it("los ítems salen ordenados por desde descendente, campañas y promociones mezcladas", async () => {
    campaniaFindManyMock.mockResolvedValue([CAMPANIA]); // desde 06/09
    promocionFindManyMock.mockResolvedValue([
      {
        id: 7, nombre: "Reciente", activa: true, items: [],
        programaciones: [{ desde: dia("2026-09-09"), hasta: dia("2026-09-14"), habilitada: true }],
        campanias: [],
      },
    ]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.items.map((i) => i.nombre)).toEqual(["Reciente", "Primavera"]);
  });

  it("con impresiones y cero clicks, la tasa es 0 y no null", async () => {
    campaniaFindManyMock.mockResolvedValue([CAMPANIA]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({
      porCampania: [
        { campaniaId: 1054, tipo: "IMPRESION_COMERCIAL", origen: "MODAL", destino: null, _count: { _all: 100 } },
      ],
    });
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.items[0].tasaClicks.MODAL).toBe(0);
  });

  it("truncado es true cuando el tope de MAX_ITEMS_METRICAS recortó el lote", async () => {
    const campanias = Array.from({ length: MAX_ITEMS_METRICAS }, (_, i) => ({
      ...CAMPANIA,
      id: i + 1,
      nombre: `Campaña ${i + 1}`,
    }));
    campaniaFindManyMock.mockResolvedValue(campanias);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.truncado).toBe(true);
  });

  it("truncado es false cuando el lote entra completo", async () => {
    campaniaFindManyMock.mockResolvedValue([CAMPANIA]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    expect(res.body.truncado).toBe(false);
  });
});
