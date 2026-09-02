import { describe, expect, it } from "vitest";
import {
  ESTADOS_ORDEN,
  ESTADOS_NO_TERMINALES,
  ESTADOS_TERMINALES,
  ESTADOS_CON_STOCK_TOMADO,
  ETIQUETA_ESTADO,
  listaDeEstados,
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

describe("listaDeEstados", () => {
  // La forma que consumen el select de estados del panel y las tarjetas de
  // AdminOperacion: valor + etiqueta + si es terminal. Existe para que el
  // frontend NO tenga su propia copia de las etiquetas — era un espejo manual
  // que había que tocar en los dos repos al agregar un estado.
  it("emite los cuatro estados en orden de flujo, con etiqueta y bandera terminal", () => {
    expect(listaDeEstados()).toEqual([
      { valor: "PENDIENTE", etiqueta: "Pendiente", terminal: false },
      { valor: "EN_PREPARACION", etiqueta: "En preparación", terminal: false },
      { valor: "ENTREGADA", etiqueta: "Entregada", terminal: true },
      { valor: "CANCELADA", etiqueta: "Cancelada", terminal: true },
    ]);
  });

  it("devuelve una copia: mutar el resultado no toca la fuente", () => {
    const lista = listaDeEstados();
    lista[0].etiqueta = "ROTO";

    expect(listaDeEstados()[0].etiqueta).toBe("Pendiente");
  });
});
