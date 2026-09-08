import { describe, expect, it } from "vitest";
import {
  ETAPAS_COMERCIALES,
  calcularTasaClicks,
  conteosVacios,
  finInclusivo,
  periodoDePromocion,
  repartirEtapas,
  repartirEventos,
} from "./metricasComerciales.js";

describe("calcularTasaClicks", () => {
  it("divide clicks sobre impresiones con cuatro decimales", () => {
    expect(calcularTasaClicks(41, 1240)).toBe(0.0331);
  });

  it("es null con cero impresiones: no se divide por cero ni se inventa un 100%", () => {
    expect(calcularTasaClicks(5, 0)).toBeNull();
    expect(calcularTasaClicks(0, 0)).toBeNull();
  });

  // Una impresión que no llegó y un click que sí: la tasa sería > 1, que es
  // mentira. Misma guarda que calcularTasa del Embudo.
  it("es null cuando hay más clicks que impresiones", () => {
    expect(calcularTasaClicks(10, 4)).toBeNull();
  });

  it("cero clicks sobre impresiones reales es 0, no null", () => {
    expect(calcularTasaClicks(0, 100)).toBe(0);
  });
});

describe("finInclusivo", () => {
  it("lleva la medianoche de `hasta` al último milisegundo de ese día", () => {
    const hasta = new Date("2026-09-16T03:00:00.000Z"); // medianoche ARG del 16
    expect(finInclusivo(hasta).toISOString()).toBe("2026-09-17T02:59:59.999Z");
  });
});

describe("periodoDePromocion", () => {
  const dia = (s) => new Date(s);

  it("es el mínimo desde y el máximo hasta de sus programaciones HABILITADAS", () => {
    const periodo = periodoDePromocion({
      programaciones: [
        { desde: dia("2026-09-10T03:00:00Z"), hasta: dia("2026-09-12T03:00:00Z"), habilitada: true },
        { desde: dia("2026-09-01T03:00:00Z"), hasta: dia("2026-09-03T03:00:00Z"), habilitada: true },
        { desde: dia("2026-08-01T03:00:00Z"), hasta: dia("2026-08-30T03:00:00Z"), habilitada: false },
      ],
      campanias: [],
    });
    expect(periodo.desde.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(periodo.hasta.toISOString()).toBe("2026-09-12T03:00:00.000Z");
  });

  it("si no tiene programaciones, toma el de las campañas que la asocian", () => {
    const periodo = periodoDePromocion({
      programaciones: [],
      campanias: [
        { campania: { desde: dia("2026-12-01T03:00:00Z"), hasta: dia("2026-12-24T03:00:00Z") } },
      ],
    });
    expect(periodo.desde.toISOString()).toBe("2026-12-01T03:00:00.000Z");
    expect(periodo.hasta.toISOString()).toBe("2026-12-24T03:00:00.000Z");
  });

  it("combina programaciones y campañas si tiene las dos", () => {
    const periodo = periodoDePromocion({
      programaciones: [
        { desde: dia("2026-09-10T03:00:00Z"), hasta: dia("2026-09-12T03:00:00Z"), habilitada: true },
      ],
      campanias: [
        { campania: { desde: dia("2026-09-01T03:00:00Z"), hasta: dia("2026-09-05T03:00:00Z") } },
      ],
    });
    expect(periodo.desde.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(periodo.hasta.toISOString()).toBe("2026-09-12T03:00:00.000Z");
  });

  // Sin período no hay contra qué acotar, y una promoción así no emite slide:
  // no puede tener eventos. Queda afuera de la lista.
  it("es null sin programaciones habilitadas ni campañas", () => {
    expect(
      periodoDePromocion({
        programaciones: [{ desde: dia("2026-09-10T03:00:00Z"), hasta: dia("2026-09-12T03:00:00Z"), habilitada: false }],
        campanias: [],
      }),
    ).toBeNull();
  });
});

describe("repartirEventos", () => {
  it("reparte las filas del groupBy en impresiones, clicks y clicksPorDestino por id", () => {
    const filas = [
      { campaniaId: 1, tipo: "IMPRESION_COMERCIAL", origen: "MODAL", destino: null, _count: { _all: 1240 } },
      { campaniaId: 1, tipo: "IMPRESION_COMERCIAL", origen: "BANNER", destino: null, _count: { _all: 3810 } },
      { campaniaId: 1, tipo: "CLICK_COMERCIAL", origen: "MODAL", destino: "CAMPANIA", _count: { _all: 41 } },
      { campaniaId: 1, tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "CAMPANIA", _count: { _all: 120 } },
      { campaniaId: 1, tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "PRODUCTO", _count: { _all: 7 } },
      { campaniaId: 2, tipo: "IMPRESION_COMERCIAL", origen: "BANNER", destino: null, _count: { _all: 9 } },
    ];

    const mapa = repartirEventos(filas, "campaniaId");

    expect(mapa.get(1)).toEqual({
      impresiones: { MODAL: 1240, BANNER: 3810 },
      clicks: { MODAL: 41, BANNER: 127 },
      clicksPorDestino: [
        { destino: "CAMPANIA", clicks: 161 },
        { destino: "PRODUCTO", clicks: 7 },
      ],
    });
    // Un origen sin filas es un CERO explícito, no una clave ausente: el
    // groupBy omite los grupos vacíos y la pantalla necesita las dos filas.
    expect(mapa.get(2)).toEqual({
      impresiones: { MODAL: 0, BANNER: 9 },
      clicks: { MODAL: 0, BANNER: 0 },
      clicksPorDestino: [],
    });
  });

  it("clicksPorDestino va ordenado por clicks descendente", () => {
    const filas = [
      { promocionId: 7, tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "PROMOCION", _count: { _all: 3 } },
      { promocionId: 7, tipo: "CLICK_COMERCIAL", origen: "MODAL", destino: "PROMOCION", _count: { _all: 50 } },
    ];
    expect(repartirEventos(filas, "promocionId").get(7).clicksPorDestino).toEqual([
      { destino: "PROMOCION", clicks: 53 },
    ]);
  });

  it("ignora filas de tipos que no son comerciales", () => {
    const filas = [
      { campaniaId: 1, tipo: "VISTA_PRODUCTO", origen: null, destino: null, _count: { _all: 99 } },
    ];
    expect(repartirEventos(filas, "campaniaId").get(1)).toBeUndefined();
  });

  it("conteosVacios es la forma de un ítem sin ningún evento", () => {
    expect(conteosVacios()).toEqual({
      impresiones: { MODAL: 0, BANNER: 0 },
      clicks: { MODAL: 0, BANNER: 0 },
      clicksPorDestino: [],
    });
  });
});

describe("repartirEtapas", () => {
  it("suma las vistas y los agregados SOLO de los productos de la vitrina de cada ítem", () => {
    const filas = [
      { productId: 10, tipo: "VISTA_PRODUCTO", _count: { _all: 300 } },
      { productId: 11, tipo: "VISTA_PRODUCTO", _count: { _all: 212 } },
      { productId: 10, tipo: "AGREGADO_CARRITO", _count: { _all: 38 } },
      { productId: 99, tipo: "VISTA_PRODUCTO", _count: { _all: 1000 } }, // de nadie
    ];
    const vitrinas = new Map([
      [1, new Set([10, 11])],
      [2, new Set([11])],
    ]);

    const mapa = repartirEtapas(filas, vitrinas);

    expect(mapa.get(1)).toEqual({ VISTAS: 512, CARRITO: 38 });
    expect(mapa.get(2)).toEqual({ VISTAS: 212, CARRITO: 0 });
  });

  it("un producto en dos vitrinas suma en las dos: no se reparte, se cuenta", () => {
    const filas = [{ productId: 11, tipo: "VISTA_PRODUCTO", _count: { _all: 5 } }];
    const vitrinas = new Map([
      [1, new Set([11])],
      [2, new Set([11])],
    ]);
    const mapa = repartirEtapas(filas, vitrinas);
    expect(mapa.get(1).VISTAS).toBe(5);
    expect(mapa.get(2).VISTAS).toBe(5);
  });

  it("ETAPAS_COMERCIALES son exactamente vistas y carrito, en ese orden", () => {
    expect(ETAPAS_COMERCIALES).toEqual([
      { clave: "VISTAS", etiqueta: "Vistas de producto", tipo: "VISTA_PRODUCTO" },
      { clave: "CARRITO", etiqueta: "Agregados al carrito", tipo: "AGREGADO_CARRITO" },
    ]);
  });
});
