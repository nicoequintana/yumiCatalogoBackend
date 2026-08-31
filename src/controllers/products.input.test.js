import { describe, it, expect } from "vitest";
import {
  coeficienteODefecto,
  parsearCategoriaId,
  validarArchivos,
  validarCostoYCoeficiente,
} from "./products.input.js";

// Buffers con firmas reales de cada formato (solo importan los primeros bytes).
const JPEG_VALIDO = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const MP4_VALIDO = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
const BASURA = Buffer.from("<script>alert(1)</script>", "utf8");

/**
 * Validación de los dos campos nuevos del editor de producto.
 *
 * Los tres valores que puede devolver cada campo son distintos y no
 * intercambiables:
 *   `undefined` -> no vino en el request, no se toca la columna
 *   `null`      -> vino vacío, se BORRA la columna
 *   string      -> valor normalizado listo para Prisma
 */
describe("validarCostoYCoeficiente", () => {
  it("no toca nada cuando ninguno de los dos viene", () => {
    expect(validarCostoYCoeficiente({})).toEqual({ costo: undefined, coeficiente: undefined });
  });

  it("normaliza valores válidos a string", () => {
    expect(validarCostoYCoeficiente({ costo: "14504", coeficiente: "2.05" })).toEqual({
      costo: "14504",
      coeficiente: "2.05",
    });
    expect(validarCostoYCoeficiente({ costo: 14504, coeficiente: 2.05 })).toEqual({
      costo: "14504",
      coeficiente: "2.05",
    });
  });

  // Un campo vaciado en el formulario tiene que poder BORRAR el dato. Sin esta
  // rama, un producto al que se le cargó un costo por error quedaría con él
  // para siempre.
  it("un valor vacío borra la columna", () => {
    expect(validarCostoYCoeficiente({ costo: "", coeficiente: "" })).toEqual({
      costo: null,
      coeficiente: null,
    });
    expect(validarCostoYCoeficiente({ costo: null, coeficiente: null })).toEqual({
      costo: null,
      coeficiente: null,
    });
  });

  it("los dos campos son independientes", () => {
    expect(validarCostoYCoeficiente({ costo: "5000" })).toEqual({
      costo: "5000",
      coeficiente: undefined,
    });
    expect(validarCostoYCoeficiente({ coeficiente: "1.8" })).toEqual({
      costo: undefined,
      coeficiente: "1.8",
    });
  });

  // El costo es plata: mismo criterio que `precio`, entero y sin decimales. Si
  // dejara pasar 1500.60, SQL Server lo guardaría como 1501 sin avisarle a
  // nadie y el margen calculado sería falso.
  it("rechaza un costo con decimales", () => {
    expect(() => validarCostoYCoeficiente({ costo: "1500.60" })).toThrow(/entero/i);
  });

  it("rechaza un costo no positivo o no numérico", () => {
    expect(() => validarCostoYCoeficiente({ costo: "0" })).toThrow(/mayor a 0/i);
    expect(() => validarCostoYCoeficiente({ costo: "-100" })).toThrow(/mayor a 0/i);
    expect(() => validarCostoYCoeficiente({ costo: "abc" })).toThrow();
    expect(() => validarCostoYCoeficiente({ costo: "Infinity" })).toThrow();
  });

  // La columna es Decimal(5,2): un tercer decimal se redondearía en silencio y
  // el precio calculado dejaría de coincidir con el que muestra la pantalla.
  it("rechaza un coeficiente con más de dos decimales", () => {
    expect(() => validarCostoYCoeficiente({ coeficiente: "2.055" })).toThrow(/dos decimales/i);
  });

  it("rechaza un coeficiente fuera del rango de la columna", () => {
    expect(() => validarCostoYCoeficiente({ coeficiente: "1000" })).toThrow(/999/);
    expect(() => validarCostoYCoeficiente({ coeficiente: "0" })).toThrow(/mayor a 0/i);
    expect(() => validarCostoYCoeficiente({ coeficiente: "-2" })).toThrow(/mayor a 0/i);
  });

  // En Argentina el coeficiente se tipea con coma. Aceptarla no es adivinar:
  // "2,05" y "2.05" son el mismo número sin ninguna ambigüedad, y un 400 por
  // el separador decimal sería una pared arbitraria. Distinto del PRECIO, donde
  // lo que se rechaza es el decimal en sí, no su notación.
  it("acepta coma como separador decimal en el coeficiente", () => {
    expect(validarCostoYCoeficiente({ coeficiente: "2,05" })).toEqual({
      costo: undefined,
      coeficiente: "2.05",
    });
  });

  it("ignora espacios alrededor", () => {
    expect(validarCostoYCoeficiente({ costo: " 14504 ", coeficiente: " 2.05 " })).toEqual({
      costo: "14504",
      coeficiente: "2.05",
    });
  });
});

/**
 * Desde el 31/08/2026 el precio de venta no se tipea: sale de
 * `costo × coeficiente`. Eso vuelve obligatorios a los dos campos en el alta y
 * en la edición.
 *
 * **La obligatoriedad es del LLAMADOR, no del validador.** `aplicarPreciosMasivo`
 * usa esta misma función para el coeficiente que se aplica a un lote, y ahí es y
 * sigue siendo opcional (`{ids, coeficiente?}`). Meter el requisito adentro del
 * validador rompería ese endpoint sin que nada lo relacione con este cambio.
 */
describe("validarCostoYCoeficiente — modos", () => {
  it('"libre" (el default) acepta ausencia y vaciado: es lo que usa precios-masivo', () => {
    expect(validarCostoYCoeficiente({})).toEqual({ costo: undefined, coeficiente: undefined });
    expect(validarCostoYCoeficiente({ costo: "", coeficiente: "" })).toEqual({
      costo: null,
      coeficiente: null,
    });
  });

  it('"alta" exige el costo', () => {
    expect(() => validarCostoYCoeficiente({ coeficiente: "2.05" }, { modo: "alta" })).toThrow(
      /costo/i,
    );
    expect(() =>
      validarCostoYCoeficiente({ costo: "", coeficiente: "2.05" }, { modo: "alta" }),
    ).toThrow(/costo/i);
  });

  it('"alta" NO exige el coeficiente: tiene un neutro y lo aplica el llamador', () => {
    expect(validarCostoYCoeficiente({ costo: "1500" }, { modo: "alta" })).toEqual({
      costo: "1500",
      coeficiente: undefined,
    });
  });

  /**
   * La distinción central del modo "edicion", y la que hace usable el PUT: es
   * un endpoint PARCIAL. Un request que solo reordena fotos no menciona el
   * costo, y fallarle por un campo que no nombra lo volvería inservible — de
   * paso dejando a cualquier producto histórico sin costo imposible de editar
   * hasta para corregirle una falta de ortografía.
   *
   * Lo que hay que impedir es que alguien BORRE el costo de un producto, no que
   * lo omita.
   */
  it('"edicion" permite OMITIR pero no VACIAR', () => {
    expect(validarCostoYCoeficiente({}, { modo: "edicion" })).toEqual({
      costo: undefined,
      coeficiente: undefined,
    });
    expect(() => validarCostoYCoeficiente({ costo: "" }, { modo: "edicion" })).toThrow(
      /costo.*no se puede borrar/i,
    );
    expect(() => validarCostoYCoeficiente({ coeficiente: null }, { modo: "edicion" })).toThrow(
      /coeficiente.*no se puede borrar/i,
    );
  });

  it("el coeficiente neutro (1) es válido en todos los modos", () => {
    for (const modo of ["libre", "alta", "edicion"]) {
      expect(validarCostoYCoeficiente({ costo: "1500", coeficiente: "1" }, { modo })).toEqual({
        costo: "1500",
        coeficiente: "1",
      });
    }
  });
});

/**
 * Defensa en profundidad: `validarArchivos` confirma los BYTES reales de cada
 * archivo, no solo el mimetype que declara el cliente (que multer ya filtró,
 * pero es falsificable). Un `.html` rotulado `image/png` pasa el filtro de
 * multer y tiene que morir acá, antes de subirse a Cloudinary.
 */
describe("validarArchivos — magic bytes", () => {
  const foto = (buffer, mimetype = "image/jpeg") => ({ buffer, mimetype, size: buffer.length });

  it("acepta una foto cuyos bytes coinciden con el mimetype", () => {
    expect(() =>
      validarArchivos({ fotosNuevas: [foto(JPEG_VALIDO)], fotosExistentesCount: 0, video: [] }),
    ).not.toThrow();
  });

  it("rechaza con 400 una foto con MIME mentido (bytes no son imagen)", () => {
    expect(() =>
      validarArchivos({ fotosNuevas: [foto(BASURA)], fotosExistentesCount: 0, video: [] }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("acepta un video cuyos bytes coinciden con el mimetype", () => {
    expect(() =>
      validarArchivos({
        fotosNuevas: [],
        fotosExistentesCount: 0,
        video: [{ buffer: MP4_VALIDO, mimetype: "video/mp4", size: MP4_VALIDO.length }],
      }),
    ).not.toThrow();
  });

  it("rechaza con 400 un video con contenido que no es MP4 ni WEBM", () => {
    expect(() =>
      validarArchivos({
        fotosNuevas: [],
        fotosExistentesCount: 0,
        video: [{ buffer: BASURA, mimetype: "video/mp4", size: BASURA.length }],
      }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });
});

/**
 * `parsearCategoriaId` es la guarda que evita que un `categoriaId` no numérico
 * llegue a Prisma como `NaN` y explote como 500. Vacío/ausente sigue siendo
 * "sin categoría" (`null`); un valor presente pero no entero es un 400 limpio.
 */
describe("parsearCategoriaId", () => {
  it("trata ausente/nulo/vacío como sin categoría", () => {
    expect(parsearCategoriaId(undefined)).toBeNull();
    expect(parsearCategoriaId(null)).toBeNull();
    expect(parsearCategoriaId("")).toBeNull();
    expect(parsearCategoriaId("   ")).toBeNull();
  });

  it("acepta un entero válido (string o número)", () => {
    expect(parsearCategoriaId("5")).toBe(5);
    expect(parsearCategoriaId(5)).toBe(5);
  });

  it("rechaza con 400 un valor no numérico", () => {
    expect(() => parsearCategoriaId("abc")).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("rechaza con 400 un valor fraccionario (categoriaId es Int en el schema)", () => {
    expect(() => parsearCategoriaId("1.5")).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("coeficienteODefecto", () => {
  it("cubre las tres formas de 'no vino'", () => {
    // Las tres llegan en la práctica: un input sin tocar manda "", una celda de
    // Excel en blanco manda null, un cliente viejo no manda el campo.
    expect(coeficienteODefecto(undefined)).toBe("1");
    expect(coeficienteODefecto(null)).toBe("1");
    expect(coeficienteODefecto("   ")).toBe("1");
  });

  it("no toca un valor real", () => {
    expect(coeficienteODefecto("2.05")).toBe("2.05");
    expect(coeficienteODefecto(2.05)).toBe(2.05);
  });
});
