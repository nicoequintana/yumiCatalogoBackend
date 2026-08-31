import { describe, expect, it } from "vitest";
import { sanitizarCelda } from "./sanitizarCelda.js";

/**
 * `sanitizarCelda` neutraliza la inyección de fórmulas en `.xlsx`: una celda de
 * texto que empieza con `=`, `+`, `-`, `@`, TAB o CR puede ejecutarse como
 * fórmula al abrir el archivo. Anteponerle un apóstrofo la fuerza a texto.
 */
describe("sanitizarCelda", () => {
  it("antepone un apóstrofo a una fórmula que empieza con '='", () => {
    expect(sanitizarCelda("=1+1")).toBe("'=1+1");
  });

  it("neutraliza cada caracter peligroso de arranque", () => {
    expect(sanitizarCelda("+1")).toBe("'+1");
    expect(sanitizarCelda("-1")).toBe("'-1");
    expect(sanitizarCelda("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(sanitizarCelda("\tcmd")).toBe("'\tcmd");
    expect(sanitizarCelda("\rcmd")).toBe("'\rcmd");
  });

  it("no toca un texto normal", () => {
    expect(sanitizarCelda("Vela de soja")).toBe("Vela de soja");
    expect(sanitizarCelda("Producto - edición")).toBe("Producto - edición");
  });

  it("no toca la cadena vacía", () => {
    expect(sanitizarCelda("")).toBe("");
  });

  it("deja los no-strings tal cual (números, null, undefined)", () => {
    expect(sanitizarCelda(1500)).toBe(1500);
    expect(sanitizarCelda(0)).toBe(0);
    expect(sanitizarCelda(null)).toBeNull();
    expect(sanitizarCelda(undefined)).toBeUndefined();
  });
});
