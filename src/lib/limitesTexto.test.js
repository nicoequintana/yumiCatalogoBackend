import { describe, expect, it } from "vitest";
import { LARGO_MAX_TEXTO, truncarTexto } from "./limitesTexto.js";

describe("truncarTexto", () => {
  it("deja intacto un texto que entra en la columna", () => {
    expect(truncarTexto("hola")).toBe("hola");
  });

  it("deja intacto un texto de exactamente el largo máximo", () => {
    const justo = "a".repeat(LARGO_MAX_TEXTO);
    expect(truncarTexto(justo)).toBe(justo);
  });

  it("recorta un texto más largo que la columna al largo máximo", () => {
    const largo = "a".repeat(LARGO_MAX_TEXTO + 500);
    expect(truncarTexto(largo)).toHaveLength(LARGO_MAX_TEXTO);
    expect(truncarTexto(largo)).toBe("a".repeat(LARGO_MAX_TEXTO));
  });

  it("degrada null y undefined a null, sin lanzar", () => {
    expect(truncarTexto(null)).toBeNull();
    expect(truncarTexto(undefined)).toBeNull();
  });

  it("acepta un largo distinto por parámetro", () => {
    expect(truncarTexto("abcdef", 3)).toBe("abc");
  });

  it("el largo máximo coincide con el NVarChar(1000) que Prisma genera para String sin @db", () => {
    expect(LARGO_MAX_TEXTO).toBe(1000);
  });
});
