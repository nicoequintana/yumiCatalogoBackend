import { describe, expect, it, vi } from "vitest";
import { COLOR_SLIDE_POR_DEFECTO, CTA_TEXTO_POR_DEFECTO } from "../lib/campanias.js";

const promocionFindManyMock = vi.fn();

// Este archivo importa el controller DIRECTO, sin pasar por una ruta HTTP:
// `aSlidePromocion` es sincrónica y pura (a diferencia de `aSlideCampania`,
// que resuelve el CTA contra la base), así que no hace falta `supertest` para
// probarla. Igual hay que mockear `lib/prisma.js` porque el módulo importa
// `prisma` a nivel de archivo, y en este entorno de test no hay
// `DATABASE_URL` real.
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    promocion: { findMany: (...args) => promocionFindManyMock(...args) },
  },
}));

const { aSlidePromocion, slidesDePromociones } = await import("./campanias.controller.js");

describe("slides de promoción", () => {
  it("emite tipo PROMOCION, promocionId y el destino derivado del id", () => {
    const slide = aSlidePromocion({
      id: 12,
      bannerTitulo: "Semana del Hogar",
      bannerTexto: "Hasta 30% off",
      bannerCtaTexto: "Ver ofertas",
      bannerColor: "VERDE",
      bannerArteUrl: "https://cdn/x.jpg",
    });

    expect(slide).toMatchObject({
      tipo: "PROMOCION",
      campaniaId: null,
      promocionId: 12,
      titulo: "Semana del Hogar",
      ctaDestino: "/coleccion?promocion=12",
      doodleUrl: null,
      color: "VERDE",
    });
  });

  it("sin color elegido cae al color de marca, no a transparente", () => {
    const slide = aSlidePromocion({ id: 1, bannerTitulo: "X", bannerColor: null });
    expect(slide.color).toBe(COLOR_SLIDE_POR_DEFECTO);
  });

  it("sin texto de botón cae al default, como las campañas", () => {
    const slide = aSlidePromocion({ id: 1, bannerTitulo: "X", bannerCtaTexto: null });
    expect(slide.ctaTexto).toBe(CTA_TEXTO_POR_DEFECTO);
  });
});

describe("slidesDePromociones — la consulta de candidatas", () => {
  it("pide las cinco condiciones: vigente, bannerEnHome, bannerTitulo, item habilitado y sin campaña", async () => {
    promocionFindManyMock.mockResolvedValue([]);

    await slidesDePromociones(new Date("2026-09-06T12:00:00Z"));

    expect(promocionFindManyMock).toHaveBeenCalledTimes(1);
    const { where, orderBy, take } = promocionFindManyMock.mock.calls[0][0];

    // La vigencia la decide `condicionPromocionVigente` — acá solo se afirma
    // que sus claves llegaron, no se copia su lógica.
    expect(where.activa).toBe(true);
    expect(where.OR).toBeInstanceOf(Array);
    // `bannerEnHome: false` NO puede matchear esta condición: es la guarda que
    // deja afuera una promoción con el banner todavía sin publicar.
    expect(where.bannerEnHome).toBe(true);
    expect(where.bannerTitulo).toEqual({ not: null });
    expect(where.items).toEqual({ some: { habilitado: true } });
    // Sin campaña asociada: si la campaña es su vidriera, ya tiene su propio
    // slide y anunciar los dos sería decir lo mismo dos veces.
    expect(where.campanias).toEqual({ none: {} });
    expect(orderBy).toEqual({ id: "desc" });
    expect(take).toBe(5);
  });

  it("mapea cada fila con aSlidePromocion, en el orden que devolvió la consulta", async () => {
    promocionFindManyMock.mockResolvedValue([
      { id: 3, bannerTitulo: "Primavera", bannerColor: null },
      { id: 1, bannerTitulo: "Invierno", bannerColor: "OCRE" },
    ]);

    const slides = await slidesDePromociones(new Date());

    expect(slides.map((s) => s.titulo)).toEqual(["Primavera", "Invierno"]);
    expect(slides.every((s) => s.tipo === "PROMOCION")).toBe(true);
  });
});
