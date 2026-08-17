import { describe, expect, it } from "vitest";
import { generarSku } from "./sku.js";

describe("generarSku", () => {
  it("arma el SKU con las primeras 6 letras en mayúsculas y el id", () => {
    expect(generarSku("Bruma Facial Botánica", 12)).toBe("YIMA-BRUMAF-12");
  });

  it("saca espacios y tildes antes de tomar las 6 letras", () => {
    expect(generarSku("Esfera Lúdica", 3)).toBe("YIMA-ESFERA-3");
  });

  it("usa lo que haya si el nombre tiene menos de 6 caracteres alfanuméricos", () => {
    expect(generarSku("Vela", 7)).toBe("YIMA-VELA-7");
  });

  it("incluye números del nombre como parte de las 6 posiciones", () => {
    expect(generarSku("iPhone 15 Pro", 8)).toBe("YIMA-IPHONE-8");
  });

  it("ignora símbolos y puntuación al armar el segmento de 6", () => {
    expect(generarSku("¡Oferta! Reloj", 9)).toBe("YIMA-OFERTA-9");
  });
});
