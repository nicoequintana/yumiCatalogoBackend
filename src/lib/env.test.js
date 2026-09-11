import { describe, expect, it, vi } from "vitest";
import {
  JWT_SECRET_MIN_BYTES,
  VARIABLES_REQUERIDAS,
  checkoutRequiereCuenta,
  cookieDominio,
  jwtSecretDebil,
  mensajeDeFaltantes,
  mensajeDeProblemas,
  validarEntorno,
  variablesFaltantes,
} from "./env.js";

const entornoCompleto = {
  DATABASE_URL: "sqlserver://localhost:1433;database=yima",
  // >= 32 bytes: un entorno válido de verdad exige un JWT_SECRET fuerte (AUTH-03).
  JWT_SECRET: "un-secreto-largo-de-mas-de-treinta-y-dos-bytes",
  // Secreto separado del de admin a propósito (ver "Secreto separado" en la
  // spec de cuentas de cliente): >= 32 bytes también.
  JWT_SECRET_CLIENTE: "otro-secreto-largo-de-mas-de-treinta-y-dos-bytes",
  CLOUDINARY_CLOUD_NAME: "yima",
  CLOUDINARY_API_KEY: "123",
  CLOUDINARY_API_SECRET: "abc",
  SMTP_USER: "yimaproductos@gmail.com",
  SMTP_PASSWORD: "abcdefghijklmnop",
  MAIL_ADMIN_DESTINO: "yimaproductos@gmail.com",
  FRONTEND_URL: "https://yima-productos.com",
  BACKEND_PUBLIC_URL: "https://api.yima-productos.com",
};

describe("variablesFaltantes", () => {
  it("no reporta nada cuando el entorno está completo", () => {
    expect(variablesFaltantes(entornoCompleto)).toEqual([]);
  });

  it("reporta TODAS las faltantes de una vez, no solo la primera", () => {
    const faltantes = variablesFaltantes({ DATABASE_URL: "algo" });

    expect(faltantes).toEqual([
      "JWT_SECRET",
      "JWT_SECRET_CLIENTE",
      "CLOUDINARY_CLOUD_NAME",
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET",
      "SMTP_USER",
      "SMTP_PASSWORD",
      "MAIL_ADMIN_DESTINO",
      "FRONTEND_URL",
      "BACKEND_PUBLIC_URL",
    ]);
  });

  it("exige las tres variables de correo", () => {
    const entorno = {
      DATABASE_URL: "x",
      JWT_SECRET: "x",
      CLOUDINARY_CLOUD_NAME: "x",
      CLOUDINARY_API_KEY: "x",
      CLOUDINARY_API_SECRET: "x",
    };

    expect(variablesFaltantes(entorno)).toEqual([
      "JWT_SECRET_CLIENTE",
      "SMTP_USER",
      "SMTP_PASSWORD",
      "MAIL_ADMIN_DESTINO",
      "FRONTEND_URL",
      "BACKEND_PUBLIC_URL",
    ]);
  });

  it("exige FRONTEND_URL, de donde salen el canonical, el JSON-LD y el sitemap", () => {
    expect(VARIABLES_REQUERIDAS).toContain("FRONTEND_URL");
  });

  it("exige BACKEND_PUBLIC_URL: sin ella urlBackend() cae a localhost sin aviso (SECRETS-02)", () => {
    expect(VARIABLES_REQUERIDAS).toContain("BACKEND_PUBLIC_URL");
    expect(variablesFaltantes({ ...entornoCompleto, BACKEND_PUBLIC_URL: undefined })).toEqual([
      "BACKEND_PUBLIC_URL",
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

    // Camino feliz: no aborta. El único log permitido es el testigo
    // informativo del flag de checkout (contrato de la spec, "Publicación"),
    // nunca una advertencia o error de faltantes/secreto débil.
    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("CHECKOUT_REQUIERE_CUENTA efectivo: false");
    expect(
      log.mock.calls.every(([mensaje]) => !/demasiado corto|faltan variables/i.test(mensaje)),
    ).toBe(true);
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

describe("jwtSecretDebil (AUTH-03)", () => {
  it("expone el umbral de 32 bytes", () => {
    expect(JWT_SECRET_MIN_BYTES).toBe(32);
  });

  it("es débil con menos de 32 bytes", () => {
    expect(jwtSecretDebil({ JWT_SECRET: "a".repeat(31) })).toBe(true);
    expect(jwtSecretDebil({ JWT_SECRET: "corto" })).toBe(true);
  });

  it("no es débil con exactamente 32 bytes ni con más", () => {
    expect(jwtSecretDebil({ JWT_SECRET: "a".repeat(32) })).toBe(false);
    expect(jwtSecretDebil({ JWT_SECRET: "a".repeat(48) })).toBe(false);
  });

  it("cuenta BYTES, no caracteres: 16 emojis son 16 chars pero 64 bytes", () => {
    // "😀" mide 4 bytes en UTF-8. 16 de ellos = 16 caracteres, 64 bytes >= 32.
    expect(jwtSecretDebil({ JWT_SECRET: "😀".repeat(16) })).toBe(false);
    // 4 emojis = 4 caracteres pero 16 bytes < 32.
    expect(jwtSecretDebil({ JWT_SECRET: "😀".repeat(4) })).toBe(true);
  });

  it("ausente o vacío NO cuenta como débil (ya lo cubre variablesFaltantes)", () => {
    expect(jwtSecretDebil({})).toBe(false);
    expect(jwtSecretDebil({ JWT_SECRET: "" })).toBe(false);
    expect(jwtSecretDebil({ JWT_SECRET: "   " })).toBe(false);
  });
});

describe("validarEntorno — fortaleza de JWT_SECRET (AUTH-03)", () => {
  it("corta el arranque con mensaje claro si JWT_SECRET es demasiado corto", () => {
    const exit = vi.fn();
    const log = vi.fn();

    validarEntorno({ entorno: { ...entornoCompleto, JWT_SECRET: "a".repeat(31) }, exit, log });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    const mensaje = log.mock.calls[0][0];
    expect(mensaje).toContain("JWT_SECRET");
    expect(mensaje).toMatch(/32/);
  });

  it("NO corta el arranque con un JWT_SECRET de 32 bytes o más y el resto completo", () => {
    const exit = vi.fn();
    const log = vi.fn();

    validarEntorno({ entorno: { ...entornoCompleto, JWT_SECRET: "a".repeat(32) }, exit, log });

    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("CHECKOUT_REQUIERE_CUENTA efectivo: false");
    expect(
      log.mock.calls.every(([mensaje]) => !/demasiado corto|faltan variables/i.test(mensaje)),
    ).toBe(true);
  });

  it("un JWT_SECRET ausente sigue reportándose como faltante (no como débil)", () => {
    const exit = vi.fn();
    const log = vi.fn();
    const { JWT_SECRET, ...sinSecret } = entornoCompleto;
    void JWT_SECRET;

    validarEntorno({ entorno: sinSecret, exit, log });

    expect(exit).toHaveBeenCalledWith(1);
    const mensaje = log.mock.calls[0][0];
    expect(mensaje).toContain("JWT_SECRET");
    expect(variablesFaltantes(sinSecret)).toContain("JWT_SECRET");
  });

  it("reporta juntas una faltante y el secreto débil, en una sola llamada a log", () => {
    const exit = vi.fn();
    const log = vi.fn();

    validarEntorno({
      entorno: { ...entornoCompleto, FRONTEND_URL: "", JWT_SECRET: "corto" },
      exit,
      log,
    });

    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    const mensaje = log.mock.calls[0][0];
    expect(mensaje).toContain("FRONTEND_URL");
    expect(mensaje).toContain("JWT_SECRET");
  });
});

// Fixture propia de estas suites nuevas: todas las VARIABLES_REQUERIDAS con un
// valor fuerte parejo, para no acoplar estos tests al contenido puntual de
// `entornoCompleto` de arriba.
const ENTORNO_COMPLETO = Object.fromEntries(VARIABLES_REQUERIDAS.map((n) => [n, "x".repeat(40)]));

describe("JWT_SECRET_CLIENTE", () => {
  it("es obligatoria", () => {
    expect(VARIABLES_REQUERIDAS).toContain("JWT_SECRET_CLIENTE");
  });

  it("jwtSecretDebil acepta el nombre de la variable y aplica el mismo minimo de 32 bytes", () => {
    expect(jwtSecretDebil({ JWT_SECRET_CLIENTE: "corto" }, "JWT_SECRET_CLIENTE")).toBe(true);
    expect(jwtSecretDebil({ JWT_SECRET_CLIENTE: "x".repeat(32) }, "JWT_SECRET_CLIENTE")).toBe(false);
    // Sin nombre sigue mirando JWT_SECRET, como siempre.
    expect(jwtSecretDebil({ JWT_SECRET: "corto" })).toBe(true);
  });

  it("validarEntorno corta el arranque si el secreto de cliente es debil, nombrandolo", () => {
    const exit = vi.fn();
    const log = vi.fn();
    validarEntorno({ entorno: { ...ENTORNO_COMPLETO, JWT_SECRET_CLIENTE: "corto" }, exit, log });
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls[0][0]).toMatch(/JWT_SECRET_CLIENTE/);
  });

  it("mensajeDeProblemas nombra cada secreto debil por separado", () => {
    const mensaje = mensajeDeProblemas({ faltantes: [], secretosDebiles: ["JWT_SECRET", "JWT_SECRET_CLIENTE"] });
    expect(mensaje).toMatch(/JWT_SECRET es demasiado corto/);
    expect(mensaje).toMatch(/JWT_SECRET_CLIENTE es demasiado corto/);
  });
});

describe("checkoutRequiereCuenta", () => {
  it("ausente es false: el estado seguro para publicar", () => {
    expect(checkoutRequiereCuenta({})).toBe(false);
  });

  it("acepta true/false con espacios y mayusculas", () => {
    expect(checkoutRequiereCuenta({ CHECKOUT_REQUIERE_CUENTA: " TRUE " })).toBe(true);
    expect(checkoutRequiereCuenta({ CHECKOUT_REQUIERE_CUENTA: "False" })).toBe(false);
  });

  it("cualquier otro valor cae a TRUE (exige cuenta): una venta menos, nunca el sitio caido", () => {
    expect(checkoutRequiereCuenta({ CHECKOUT_REQUIERE_CUENTA: "1" })).toBe(true);
    expect(checkoutRequiereCuenta({ CHECKOUT_REQUIERE_CUENTA: "si" })).toBe(true);
    expect(checkoutRequiereCuenta({ CHECKOUT_REQUIERE_CUENTA: "" })).toBe(false);
  });

  it("validarEntorno NO aborta por un flag invalido, pero lo loguea", () => {
    const exit = vi.fn();
    const log = vi.fn();
    validarEntorno({ entorno: { ...ENTORNO_COMPLETO, CHECKOUT_REQUIERE_CUENTA: "1" }, exit, log });
    expect(exit).not.toHaveBeenCalled();
    expect(log.mock.calls.some(([m]) => /CHECKOUT_REQUIERE_CUENTA/.test(m) && /"1"/.test(m))).toBe(true);
  });
});

describe("cookieDominio", () => {
  it("devuelve undefined si no esta o esta vacia (desarrollo en localhost)", () => {
    expect(cookieDominio({})).toBeUndefined();
    expect(cookieDominio({ COOKIE_DOMINIO: "  " })).toBeUndefined();
  });

  it("devuelve el valor recortado", () => {
    expect(cookieDominio({ COOKIE_DOMINIO: " .yima-productos.com " })).toBe(".yima-productos.com");
  });
});
