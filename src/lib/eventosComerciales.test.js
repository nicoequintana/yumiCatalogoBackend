import { describe, expect, it } from "vitest";
import { TIPOS_DESTINO_CTA } from "./campanias.js";
import {
  DESTINOS_COMERCIALES,
  ETIQUETA_DESTINO_COMERCIAL,
  ETIQUETA_ORIGEN_COMERCIAL,
  ORIGENES_COMERCIALES,
  TIPOS_COMERCIALES,
  listaDeOrigenesComerciales,
  validarEventoComercial,
} from "./eventosComerciales.js";

describe("diccionarios", () => {
  it("los dos tipos, los dos orígenes y los cinco destinos son exactamente estos", () => {
    expect(TIPOS_COMERCIALES).toEqual(["IMPRESION_COMERCIAL", "CLICK_COMERCIAL"]);
    expect(ORIGENES_COMERCIALES).toEqual(["MODAL", "BANNER"]);
    expect(DESTINOS_COMERCIALES).toEqual([
      "CAMPANIA",
      "CATALOGO",
      "CATEGORIA",
      "PRODUCTO",
      "PROMOCION",
    ]);
  });

  // El guard de que los cuatro primeros destinos NO se reescriben a mano.
  // Con una copia manual, una quinta intención de CTA saldría en `ctaTipo` de
  // /campanias/activas, el frontend la mandaría y esta puerta contestaría 400:
  // los clicks de esas campañas dejarían de contarse con el síntoma "esta
  // campaña no tuvo clicks", que no señala a ningún lado.
  it("los cuatro primeros destinos SALEN de TIPOS_DESTINO_CTA, no de una copia", () => {
    expect(DESTINOS_COMERCIALES.slice(0, TIPOS_DESTINO_CTA.length)).toEqual([
      ...TIPOS_DESTINO_CTA,
    ]);
    expect(DESTINOS_COMERCIALES).toHaveLength(TIPOS_DESTINO_CTA.length + 1);
    expect(DESTINOS_COMERCIALES.at(-1)).toBe("PROMOCION");
  });

  // Mismo guard que `ETIQUETA_DESTINO_CTA` en `campanias.js`: todo valor tiene
  // su etiqueta y no sobra ninguna. El sobre de métricas comerciales las emite
  // porque el panel no tiene diccionario propio.
  it("todo destino comercial tiene etiqueta y no sobra ninguna", () => {
    expect(Object.keys(ETIQUETA_DESTINO_COMERCIAL).sort()).toEqual(
      [...DESTINOS_COMERCIALES].sort(),
    );
    expect(Object.values(ETIQUETA_DESTINO_COMERCIAL).every((t) => t.length > 0)).toBe(true);
  });

  it("todo origen tiene etiqueta y no sobra ninguna", () => {
    expect(Object.keys(ETIQUETA_ORIGEN_COMERCIAL).sort()).toEqual([...ORIGENES_COMERCIALES].sort());
    expect(Object.values(ETIQUETA_ORIGEN_COMERCIAL).every((t) => t.length > 0)).toBe(true);
  });

  it("listaDeOrigenesComerciales devuelve valor + etiqueta, en el orden del diccionario", () => {
    expect(listaDeOrigenesComerciales()).toEqual([
      { valor: "MODAL", etiqueta: "Cartel" },
      { valor: "BANNER", etiqueta: "Slide del carrusel" },
    ]);
    // Objetos NUEVOS en cada llamada, mismo criterio que `listaDeTipos`.
    expect(listaDeOrigenesComerciales()[0]).not.toBe(listaDeOrigenesComerciales()[0]);
  });
});

describe("validarEventoComercial", () => {
  it("una impresión válida devuelve destino null", () => {
    expect(validarEventoComercial({ tipo: "IMPRESION_COMERCIAL", origen: "BANNER" })).toEqual({
      tipo: "IMPRESION_COMERCIAL",
      origen: "BANNER",
      destino: null,
    });
  });

  it("un click válido devuelve su destino", () => {
    expect(
      validarEventoComercial({ tipo: "CLICK_COMERCIAL", origen: "MODAL", destino: "PRODUCTO" }),
    ).toEqual({ tipo: "CLICK_COMERCIAL", origen: "MODAL", destino: "PRODUCTO" });
  });

  // Los seis tipos históricos se rechazan ACÁ: esta puerta no es una segunda
  // forma de fabricar VISTA_PRODUCTO desde afuera.
  it.each([
    "VISTA_PRODUCTO",
    "CLICK_WHATSAPP",
    "FAVORITO_AGREGADO",
    "AGREGADO_CARRITO",
    "ORDEN_CREADA",
    "COMPARTIDO",
    "OTRA_COSA",
    undefined,
  ])("rechaza con 400 el tipo %s", (tipo) => {
    expect(() => validarEventoComercial({ tipo, origen: "MODAL" })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it.each(["modal", "SLIDE", "", undefined])("rechaza con 400 el origen %s", (origen) => {
    expect(() => validarEventoComercial({ tipo: "IMPRESION_COMERCIAL", origen })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("un click SIN destino es 400", () => {
    expect(() => validarEventoComercial({ tipo: "CLICK_COMERCIAL", origen: "BANNER" })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("un click con destino fuera del diccionario es 400", () => {
    expect(() =>
      validarEventoComercial({ tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "HOME" }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  // Una impresión todavía no decidió nada: un destino ahí es un cuerpo mal
  // armado, no un dato.
  it("una impresión CON destino es 400", () => {
    expect(() =>
      validarEventoComercial({ tipo: "IMPRESION_COMERCIAL", origen: "MODAL", destino: "CAMPANIA" }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("un body ausente es 400, no un TypeError", () => {
    expect(() => validarEventoComercial(undefined)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});
