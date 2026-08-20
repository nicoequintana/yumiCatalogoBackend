import { describe, expect, it } from "vitest";
import { generarSku } from "./sku.js";

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
