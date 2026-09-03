import { describe, expect, it, vi, beforeEach } from "vitest";
import { inicioDelDiaArgentino } from "./horarioArgentino.js";
import { resolverDescuentos } from "./precioEfectivo.js";

/**
 * Guard de la resolución EN LOTE de descuentos.
 *
 * Dos propiedades definen esta función y las dos se afirman acá:
 *
 * 1. **UNA consulta por request, no una por producto.** Corre en cada listado
 *    del catálogo, que trae doce productos: doce consultas serían un N+1 en la
 *    pantalla que más se mira.
 * 2. **Sin promociones vigentes hace cortocircuito** y no toca la base, que es
 *    el caso normal el 90 % de los días.
 */

const findManyMock = vi.fn();
const prismaFalso = { promocionItem: { findMany: (...args) => findManyMock(...args) } };

/** 15/09/2026 a las 10:00 de Buenos Aires. */
const AHORA = new Date(inicioDelDiaArgentino("2026-09-15").getTime() + 10 * 3_600_000);

function item(extra = {}) {
  return {
    productId: 1,
    porcentaje: 15,
    promocion: { id: 7, nombre: "Promo Hogar" },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  findManyMock.mockResolvedValue([]);
});

describe("resolverDescuentos", () => {
  it("devuelve un Map de productId al descuento que le corresponde", async () => {
    findManyMock.mockResolvedValue([item()]);

    const mapa = await resolverDescuentos(prismaFalso, [1, 2], AHORA);

    expect(mapa.get(1)).toEqual({ porcentaje: 15, promocionId: 7, promocionNombre: "Promo Hogar" });
    expect(mapa.get(2)).toBeUndefined();
  });

  it("hace UNA sola consulta, no una por producto", async () => {
    findManyMock.mockResolvedValue([]);

    await resolverDescuentos(prismaFalso, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], AHORA);

    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  it("sin ids NO toca la base", async () => {
    // El catálogo puede pedir una página vacía, y `obtenerRelacionados` puede no
    // traer ninguno. Una consulta con `in: []` es una consulta al pedo.
    expect((await resolverDescuentos(prismaFalso, [], AHORA)).size).toBe(0);
    expect((await resolverDescuentos(prismaFalso, null, AHORA)).size).toBe(0);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("solo pide los items HABILITADOS de los productos pedidos", async () => {
    await resolverDescuentos(prismaFalso, [3, 9], AHORA);

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.productId).toEqual({ in: [3, 9] });
    // `habilitado: false` es la decisión persistida de un conflicto perdido: no
    // puede volver por la puerta de atrás en la resolución del precio.
    expect(where.habilitado).toBe(true);
  });

  it("exige que la promoción esté vigente por programación O por campaña", async () => {
    await resolverDescuentos(prismaFalso, [1], AHORA);

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.promocion.activa).toBe(true);
    expect(where.promocion.OR).toHaveLength(2);

    const [porProgramacion, porCampania] = where.promocion.OR;
    // Programación individual: habilitada y en fecha.
    expect(porProgramacion.programaciones.some.habilitada).toBe(true);
    // Dentro de campaña: la campaña HABILITADA y en fecha. Apagar la campaña
    // apaga todas sus promociones de una.
    expect(porCampania.campanias.some.campania.estado).toBe("HABILITADA");
  });

  it("la frontera de fin es la MEDIANOCHE DE HOY, no el instante", async () => {
    // `hasta` guarda una medianoche argentina: que sea >= la de hoy significa
    // "su último día es hoy o más adelante". Comparar contra `ahora` apagaría
    // toda promo que termine hoy, a cualquier hora del día.
    await resolverDescuentos(prismaFalso, [1], AHORA);

    const { where } = findManyMock.mock.calls[0][0];
    const { hasta } = where.promocion.OR[0].programaciones.some;

    expect(hasta.gte.toISOString()).toBe("2026-09-15T03:00:00.000Z");
  });

  it("con DOS descuentos sobre el mismo producto gana el MENOR", async () => {
    // Es un conflicto que el admin todavía no resolvió. El catálogo tiene que
    // mostrar algo, y el menor nunca regala más de lo previsto. La alerta del
    // panel es la que empuja a decidir; mientras tanto, el sitio es conservador.
    findManyMock.mockResolvedValue([
      item({ porcentaje: 30, promocion: { id: 1, nombre: "Agresiva" } }),
      item({ porcentaje: 10, promocion: { id: 2, nombre: "Suave" } }),
    ]);

    const mapa = await resolverDescuentos(prismaFalso, [1], AHORA);

    expect(mapa.get(1).porcentaje).toBe(10);
    expect(mapa.get(1).promocionId).toBe(2);
  });

  it("el orden en que vuelven de la base no cambia quién gana", async () => {
    findManyMock.mockResolvedValue([
      item({ porcentaje: 10, promocion: { id: 2, nombre: "Suave" } }),
      item({ porcentaje: 30, promocion: { id: 1, nombre: "Agresiva" } }),
    ]);

    expect((await resolverDescuentos(prismaFalso, [1], AHORA)).get(1).porcentaje).toBe(10);
  });

  it("descarta un porcentaje fuera de rango en vez de aplicarlo", async () => {
    // La validación vive en la entrada, pero un dato viejo o tocado a mano en la
    // base no puede producir un precio absurdo en la vidriera.
    findManyMock.mockResolvedValue([item({ porcentaje: 90 })]);

    expect((await resolverDescuentos(prismaFalso, [1], AHORA)).get(1)).toBeUndefined();
  });

  it("resuelve varios productos en el mismo lote", async () => {
    findManyMock.mockResolvedValue([
      item({ productId: 1, porcentaje: 10 }),
      item({ productId: 5, porcentaje: 25 }),
    ]);

    const mapa = await resolverDescuentos(prismaFalso, [1, 5], AHORA);

    expect(mapa.get(1).porcentaje).toBe(10);
    expect(mapa.get(5).porcentaje).toBe(25);
    expect(mapa.size).toBe(2);
  });
});
