import { describe, expect, it } from "vitest";
import {
  COLORES_ETIQUETA,
  esColorEtiquetaValido,
  resolverColorEtiqueta,
} from "./coloresEtiqueta.js";

/** Luminancia relativa WCAG de un color en canales ("157 62 29"). */
function luminancia(canales) {
  const [r, g, b] = canales.split(" ").map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contraste(a, b) {
  const [alto, bajo] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (alto + 0.05) / (bajo + 0.05);
}

const CANALES = /^\d{1,3} \d{1,3} \d{1,3}$/;

describe("COLORES_ETIQUETA", () => {
  it("tiene exactamente 20 colores", () => {
    expect(COLORES_ETIQUETA).toHaveLength(20);
  });

  it("no repite ids", () => {
    const ids = COLORES_ETIQUETA.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("expresa fondo y texto en CANALES, nunca en hex", () => {
    for (const color of COLORES_ETIQUETA) {
      expect(color.fondo, `${color.id}.fondo`).toMatch(CANALES);
      expect(color.texto, `${color.id}.texto`).toMatch(CANALES);
      for (const canal of [...color.fondo.split(" "), ...color.texto.split(" ")]) {
        expect(Number(canal)).toBeGreaterThanOrEqual(0);
        expect(Number(canal)).toBeLessThanOrEqual(255);
      }
    }
  });

  // El guard que importa: impide sumar un color ilegible sin enterarse.
  it("cada par texto/fondo alcanza el contraste WCAG AA (4.5)", () => {
    for (const color of COLORES_ETIQUETA) {
      expect(contraste(color.fondo, color.texto), `${color.id}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // El chip se dibuja sobre la página clara del catálogo y sobre el admin
  // oscuro. Un color que se funde con cualquiera de las dos es invisible.
  it("cada fondo se distingue de las dos superficies (claro y oscuro)", () => {
    const CLARO = "255 248 245";
    const OSCURO = "22 19 15";
    for (const color of COLORES_ETIQUETA) {
      expect(contraste(color.fondo, CLARO), `${color.id} vs claro`).toBeGreaterThanOrEqual(1.6);
      expect(contraste(color.fondo, OSCURO), `${color.id} vs oscuro`).toBeGreaterThanOrEqual(1.6);
    }
  });
});

describe("resolverColorEtiqueta", () => {
  it("devuelve el color completo para un id conocido", () => {
    expect(resolverColorEtiqueta("TERRACOTA")).toEqual({
      id: "TERRACOTA",
      nombre: "Terracota",
      fondo: "157 62 29",
      texto: "255 255 255",
    });
  });

  it("devuelve null para null, undefined y un id desconocido", () => {
    expect(resolverColorEtiqueta(null)).toBeNull();
    expect(resolverColorEtiqueta(undefined)).toBeNull();
    expect(resolverColorEtiqueta("FUCSIA_INVENTADO")).toBeNull();
  });
});

describe("esColorEtiquetaValido", () => {
  it("acepta un id de la paleta y rechaza cualquier otra cosa", () => {
    expect(esColorEtiquetaValido("VERDE")).toBe(true);
    expect(esColorEtiquetaValido("verde")).toBe(false);
    expect(esColorEtiquetaValido("#ff0000")).toBe(false);
    expect(esColorEtiquetaValido(null)).toBe(false);
  });
});
