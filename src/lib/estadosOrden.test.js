import { describe, expect, it } from "vitest";
import { ESTADOS_ORDEN, ETIQUETA_ESTADO } from "./estadosOrden.js";

describe("ETIQUETA_ESTADO", () => {
  it("tiene una etiqueta para cada uno de los cinco estados", () => {
    for (const estado of ESTADOS_ORDEN) {
      expect(typeof ETIQUETA_ESTADO[estado]).toBe("string");
      expect(ETIQUETA_ESTADO[estado].length).toBeGreaterThan(0);
    }
  });

  it("no tiene claves de más (espejo exacto de ESTADOS_ORDEN)", () => {
    expect(Object.keys(ETIQUETA_ESTADO).sort()).toEqual([...ESTADOS_ORDEN].sort());
  });

  it("escribe EN_PREPARACION con acento y en minúscula", () => {
    expect(ETIQUETA_ESTADO.EN_PREPARACION).toBe("En preparación");
  });
});
