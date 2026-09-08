import { describe, expect, it } from "vitest";
import {
  DESTINOS_COMERCIALES,
  ORIGENES_COMERCIALES,
  TIPOS_COMERCIALES,
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
