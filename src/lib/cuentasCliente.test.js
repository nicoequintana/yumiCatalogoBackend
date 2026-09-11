import { describe, expect, it } from "vitest";
import {
  COOKIE_DISPOSITIVO,
  COOKIE_SESION,
  DURACION_TOKEN_MS,
  MAX_INTENTOS_CODIGO,
  MAX_INTENTOS_LOGIN,
  ORIGENES_REGISTRO,
  TIPOS_TOKEN,
  esGmail,
  normalizarEmail,
} from "./cuentasCliente.js";

describe("cuentasCliente — constantes", () => {
  it("expone las listas cerradas con los valores exactos de la spec", () => {
    expect(ORIGENES_REGISTRO).toEqual({ LOCAL: "LOCAL", GOOGLE: "GOOGLE" });
    expect(TIPOS_TOKEN).toEqual({
      VERIFICACION: "VERIFICACION",
      RESET: "RESET",
      CAMBIO_EMAIL: "CAMBIO_EMAIL",
      CODIGO_ACCESO: "CODIGO_ACCESO",
    });
  });

  it("el RESET dura 1 hora y la VERIFICACION 24: una ventana de reseteo abierta es una llave en un buzón", () => {
    expect(DURACION_TOKEN_MS.RESET).toBe(60 * 60 * 1000);
    expect(DURACION_TOKEN_MS.VERIFICACION).toBe(24 * 60 * 60 * 1000);
    expect(DURACION_TOKEN_MS.CODIGO_ACCESO).toBe(10 * 60 * 1000);
  });

  it("los topes de intentos son los de la spec", () => {
    expect(MAX_INTENTOS_LOGIN).toBe(10);
    expect(MAX_INTENTOS_CODIGO).toBe(5);
  });

  it("los nombres de cookie son distintos entre sí y del admin", () => {
    expect(COOKIE_SESION).toBe("sesion_cliente");
    expect(COOKIE_DISPOSITIVO).toBe("dispositivo_cliente");
    expect(COOKIE_SESION).not.toBe("admin_token");
  });
});

describe("esGmail", () => {
  it("acepta gmail.com y googlemail.com sin importar mayúsculas", () => {
    expect(esGmail("Juan@Gmail.com")).toBe(true);
    expect(esGmail("juan@googlemail.com")).toBe(true);
  });

  it("rechaza cualquier otro dominio, incluidos los que contienen 'gmail'", () => {
    expect(esGmail("juan@empresa.com")).toBe(false);
    expect(esGmail("juan@gmail.com.ar")).toBe(false);
    expect(esGmail("juan@notgmail.com")).toBe(false);
    expect(esGmail("")).toBe(false);
    expect(esGmail(null)).toBe(false);
  });
});

describe("normalizarEmail", () => {
  it("recorta y pasa a minúsculas: Victima@Gmail.com y victima@gmail.com son el mismo balde", () => {
    expect(normalizarEmail("  Victima@Gmail.com ")).toBe("victima@gmail.com");
  });

  it("devuelve cadena vacía ante lo que no es string", () => {
    expect(normalizarEmail(undefined)).toBe("");
    expect(normalizarEmail(42)).toBe("");
  });
});
