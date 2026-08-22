import { describe, expect, it, vi } from "vitest";
import { VARIABLES_REQUERIDAS, mensajeDeFaltantes, validarEntorno, variablesFaltantes } from "./env.js";

const entornoCompleto = {
  DATABASE_URL: "sqlserver://localhost:1433;database=yima",
  JWT_SECRET: "un-secreto",
  CLOUDINARY_CLOUD_NAME: "yima",
  CLOUDINARY_API_KEY: "123",
  CLOUDINARY_API_SECRET: "abc",
};

describe("variablesFaltantes", () => {
  it("no reporta nada cuando el entorno está completo", () => {
    expect(variablesFaltantes(entornoCompleto)).toEqual([]);
  });

  it("reporta TODAS las faltantes de una vez, no solo la primera", () => {
    const faltantes = variablesFaltantes({ DATABASE_URL: "algo" });

    expect(faltantes).toEqual([
      "JWT_SECRET",
      "CLOUDINARY_CLOUD_NAME",
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET",
    ]);
  });

  it("trata una variable definida pero vacía como faltante", () => {
    expect(variablesFaltantes({ ...entornoCompleto, JWT_SECRET: "" })).toEqual(["JWT_SECRET"]);
    expect(variablesFaltantes({ ...entornoCompleto, JWT_SECRET: "   " })).toEqual(["JWT_SECRET"]);
  });

  it("no exige las variables legado de Google Drive", () => {
    expect(VARIABLES_REQUERIDAS.some((nombre) => nombre.startsWith("GOOGLE_"))).toBe(false);
  });

  it("exige las credenciales de Cloudinary, que hoy se validan recién en la primera subida", () => {
    expect(VARIABLES_REQUERIDAS).toContain("CLOUDINARY_CLOUD_NAME");
    expect(VARIABLES_REQUERIDAS).toContain("CLOUDINARY_API_KEY");
    expect(VARIABLES_REQUERIDAS).toContain("CLOUDINARY_API_SECRET");
  });
});

describe("mensajeDeFaltantes", () => {
  it("nombra cada variable faltante en el mensaje", () => {
    const mensaje = mensajeDeFaltantes(["JWT_SECRET", "CLOUDINARY_API_KEY"]);

    expect(mensaje).toContain("JWT_SECRET");
    expect(mensaje).toContain("CLOUDINARY_API_KEY");
    expect(mensaje).toContain(".env.example");
  });
});

describe("validarEntorno", () => {
  it("no corta el arranque cuando el entorno está completo", () => {
    const exit = vi.fn();
    const log = vi.fn();

    validarEntorno({ entorno: entornoCompleto, exit, log });

    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("loguea el detalle y corta con código 1 cuando falta algo", () => {
    const exit = vi.fn();
    const log = vi.fn();

    validarEntorno({ entorno: { DATABASE_URL: "algo", JWT_SECRET: "otro" }, exit, log });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    const mensaje = log.mock.calls[0][0];
    expect(mensaje).toContain("CLOUDINARY_CLOUD_NAME");
    expect(mensaje).toContain("CLOUDINARY_API_KEY");
    expect(mensaje).toContain("CLOUDINARY_API_SECRET");
  });

  it("importar el módulo no valida nada por sí solo (los 40+ tests importan rutas sin entorno completo)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});

    await import("./env.js?recarga-para-verificar-efectos");

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
