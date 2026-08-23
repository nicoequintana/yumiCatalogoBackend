import { describe, expect, it, vi } from "vitest";
import { generarSku, generarSkusUnicos } from "./sku.js";

describe("generarSku", () => {
  it("arma el SKU con las primeras 6 letras en mayúsculas y un sufijo de 4 dígitos", () => {
    expect(generarSku("Bruma Facial Botánica")).toMatch(/^YIMA-BRUMAF-\d{4}$/);
  });

  it("saca espacios y tildes antes de tomar las 6 letras", () => {
    expect(generarSku("Esfera Lúdica")).toMatch(/^YIMA-ESFERA-\d{4}$/);
  });

  it("usa lo que haya si el nombre tiene menos de 6 caracteres alfanuméricos", () => {
    expect(generarSku("Vela")).toMatch(/^YIMA-VELA-\d{4}$/);
  });

  it("incluye números del nombre como parte de las 6 posiciones", () => {
    expect(generarSku("iPhone 15 Pro")).toMatch(/^YIMA-IPHONE-\d{4}$/);
  });

  it("ignora símbolos y puntuación al armar el segmento de 6", () => {
    expect(generarSku("¡Oferta! Reloj")).toMatch(/^YIMA-OFERTA-\d{4}$/);
  });

  it("genera sufijos distintos entre llamadas (no determinístico)", () => {
    const skus = new Set(Array.from({ length: 20 }, () => generarSku("Vela")));
    expect(skus.size).toBeGreaterThan(1);
  });
});

describe("generarSkusUnicos", () => {
  it("genera un sku por nombre, en el mismo orden", () => {
    const skus = generarSkusUnicos(["Vela de soja", "Difusor cítrico"]);

    expect(skus).toHaveLength(2);
    expect(skus[0]).toMatch(/^YIMA-VELADE-\d{4}$/);
    expect(skus[1]).toMatch(/^YIMA-DIFUSO-\d{4}$/);
  });

  it("no colisiona contra los skus ya existentes en la base", () => {
    const secuencia = [0.1, 0.1, 0.9]; // colisiona una vez, después libera
    let indice = 0;
    const randomSpy = vi.spyOn(Math, "random").mockImplementation(() => {
      const valor = secuencia[Math.min(indice, secuencia.length - 1)];
      indice += 1;
      return valor;
    });

    try {
      const skusExistentes = new Set(["YIMA-VELA-1100"]);
      const [sku] = generarSkusUnicos(["Vela"], skusExistentes);

      expect(sku).not.toBe("YIMA-VELA-1100");
      expect(skusExistentes.has(sku)).toBe(false);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("no colisiona entre dos nombres iguales en el mismo lote", () => {
    const secuencia = [0.1, 0.1, 0.1, 0.9]; // 3 colisiones seguidas, la 4ta libera
    let indice = 0;
    const randomSpy = vi.spyOn(Math, "random").mockImplementation(() => {
      const valor = secuencia[Math.min(indice, secuencia.length - 1)];
      indice += 1;
      return valor;
    });

    try {
      const skus = generarSkusUnicos(["Vela", "Vela"]);

      expect(skus[0]).not.toBe(skus[1]);
    } finally {
      randomSpy.mockRestore();
    }
  });
});
