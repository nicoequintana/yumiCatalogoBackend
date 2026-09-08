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
      clicksPorDestino: [{ destino: "CAMPANIA", clicks: 168 }],
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

  it("los groupBy de eventos se acotan al rango TOTAL del lote y NUNCA cargan filas", async () => {
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
    // Del `desde` más viejo al fin INCLUSIVO del `hasta` más nuevo.
    expect(llamadaCampania.where.createdAt.gte.toISOString()).toBe("2026-08-01T03:00:00.000Z");
    expect(llamadaCampania.where.createdAt.lte.toISOString()).toBe("2026-09-17T02:59:59.999Z");
    expect(llamadaCampania.where.campaniaId).toEqual({ in: [1054, 2] });
  });

  it("las etapas se acotan a los productos de las vitrinas del lote y a su período", async () => {
    campaniaFindManyMock.mockResolvedValue([CAMPANIA]);
    promocionFindManyMock.mockResolvedValue([]);
    programarGroupBy({});
    const { req, res, next } = buildReqRes();

    await metricasComerciales(req, res, next);

    const llamadaEtapas = eventoGroupByMock.mock.calls.find(([arg]) => arg.by?.includes("productId"))[0];
    expect(llamadaEtapas.by).toEqual(["productId", "tipo"]);
    expect(llamadaEtapas.where.productId).toEqual({ in: [10, 11] });
    expect(llamadaEtapas.where.tipo).toEqual({ in: ["VISTA_PRODUCTO", "AGREGADO_CARRITO"] });
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
      clicksPorDestino: [{ destino: "PROMOCION", clicks: 9 }],
    });
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
