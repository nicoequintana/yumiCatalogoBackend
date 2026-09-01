import { describe, expect, it } from "vitest";
import {
  ESTADOS_ORDEN,
  ESTADOS_NO_TERMINALES,
  ESTADOS_TERMINALES,
  ESTADOS_CON_STOCK_TOMADO,
  ETIQUETA_ESTADO,
} from "./estadosOrden.js";

describe("estadosOrden", () => {
  it("no incluye CONFIRMADA en ninguna lista ni etiqueta", () => {
    expect(ESTADOS_ORDEN).not.toContain("CONFIRMADA");
    expect(ESTADOS_NO_TERMINALES).not.toContain("CONFIRMADA");
    expect(ESTADOS_TERMINALES).not.toContain("CONFIRMADA");
    expect(ESTADOS_CON_STOCK_TOMADO).not.toContain("CONFIRMADA");
    expect(ETIQUETA_ESTADO).not.toHaveProperty("CONFIRMADA");
  });

  it("los cuatro estados van en orden de flujo", () => {
    expect(ESTADOS_ORDEN).toEqual([
      "PENDIENTE",
      "EN_PREPARACION",
      "ENTREGADA",
      "CANCELADA",
    ]);
  });

  it("toma stock todo estado que significa que la mercadería salió", () => {
    // ENTREGADA está incluida a propósito: sin máquina de estados, una orden
    // puede ir de PENDIENTE directo a ENTREGADA, y ese camino tiene que
    // descontar stock igual que pasar por EN_PREPARACION.
    expect(ESTADOS_CON_STOCK_TOMADO).toEqual(["EN_PREPARACION", "ENTREGADA"]);
  });

  it("cada estado tiene etiqueta legible", () => {
    for (const estado of ESTADOS_ORDEN) {
      expect(typeof ETIQUETA_ESTADO[estado]).toBe("string");
      expect(ETIQUETA_ESTADO[estado].length).toBeGreaterThan(0);
    }
  });
});

describe("ETIQUETA_ESTADO", () => {
  it("tiene una etiqueta para cada uno de los cuatro estados", () => {
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
