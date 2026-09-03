import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import {
  PORCENTAJE_MAX,
  PORCENTAJE_MIN,
  esPorcentajeValido,
  precioConDescuento,
} from "./precioEfectivo.js";

/**
 * Guard del cálculo del precio promocional.
 *
 * Afirma sobre el `Decimal` CRUDO, sin formatear, y eso no es un detalle: es la
 * lección de `dinero.test.js`. Los guards de "nunca float" vivían en los tests
 * de las rutas, comparando strings ya pasados por `.toFixed(0)` — y desde que
 * los montos son enteros, float y `Decimal` producen exactamente el mismo
 * string. Un test que no puede fallar cuando la regla se rompe no es un guard.
 */

describe("precioConDescuento", () => {
  it("el caso del pedido: 20.000 menos 10% da 18.000", () => {
    expect(precioConDescuento("20000", 10).toString()).toBe("18000");
  });

  it("devuelve Decimal, no number", () => {
    // Si esto devolviera float, el redondeo de un caso al medio peso dependería
    // del error de representación binaria en vez de la regla del proyecto.
    expect(precioConDescuento("20000", 10)).toBeInstanceOf(Decimal);
  });

  it("redondea al peso con el medio hacia arriba", () => {
    // 90 × 55 / 100 = 49,5 → 50. Es la MISMA regla que `redondearAEntero` de
    // `lib/precios.js`, y sale de ahí: no hay una segunda definición de
    // redondeo en el sistema.
    expect(precioConDescuento("90", 45).toString()).toBe("50");
    // 50 × 51 / 100 = 25,5 → 26.
    expect(precioConDescuento("50", 49).toString()).toBe("26");
  });

  it("un porcentaje que produce fracción NUNCA deja centavos", () => {
    // Ningún monto del sistema tiene decimales, ni siquiera el derivado de un
    // descuento. 999 × 90 / 100 = 899,1.
    const resultado = precioConDescuento("999", 10);

    expect(resultado.toString()).toBe("899");
    expect(resultado.decimalPlaces()).toBe(0);
  });

  it("acepta el precio como Decimal, string o number", () => {
    expect(precioConDescuento(new Decimal("20000"), 10).toString()).toBe("18000");
    expect(precioConDescuento("20000", 10).toString()).toBe("18000");
    expect(precioConDescuento(20000, 10).toString()).toBe("18000");
  });

  it("los dos extremos del rango son válidos", () => {
    expect(precioConDescuento("1000", PORCENTAJE_MIN).toString()).toBe("950");
    expect(precioConDescuento("1000", PORCENTAJE_MAX).toString()).toBe("500");
  });

  it("un porcentaje fuera de rango devuelve null, NUNCA el precio sin tocar", () => {
    // Devolver el precio de lista ante un porcentaje inválido escondería el
    // error: la card mostraría un descuento que no descuenta. `null` obliga a
    // quien llama a decidir qué hacer.
    for (const invalido of [0, 4, 51, 100, -10]) {
      expect(precioConDescuento("1000", invalido), `porcentaje: ${invalido}`).toBeNull();
    }
  });

  it("una entrada que no es un número devuelve null", () => {
    for (const invalido of [NaN, null, undefined, "diez", {}, 10.5]) {
      expect(precioConDescuento("1000", invalido), `porcentaje: ${invalido}`).toBeNull();
    }
  });

  it("un precio ilegible devuelve null", () => {
    expect(precioConDescuento(null, 10)).toBeNull();
    expect(precioConDescuento("", 10)).toBeNull();
    expect(precioConDescuento("gratis", 10)).toBeNull();
  });

  it("un precio de CERO da cero, no null", () => {
    // Cero es un precio raro pero válido, y es distinto de "no se puede
    // calcular". Mismo criterio que `costoDeItem` en `dinero.js`.
    const resultado = precioConDescuento("0", 10);

    expect(resultado).not.toBeNull();
    expect(resultado.toString()).toBe("0");
  });

  it("nunca devuelve un precio mayor al de lista", () => {
    // La invariante de la feature: un descuento descuenta. Con el tope en 50 %
    // el resultado siempre está entre la mitad y el 95 % del precio.
    for (let pct = PORCENTAJE_MIN; pct <= PORCENTAJE_MAX; pct += 1) {
      const efectivo = precioConDescuento("17900", pct);
      expect(efectivo.lessThan("17900"), `porcentaje: ${pct}`).toBe(true);
      expect(efectivo.greaterThanOrEqualTo("8950"), `porcentaje: ${pct}`).toBe(true);
    }
  });
});

describe("esPorcentajeValido", () => {
  it("acepta enteros entre 5 y 50 inclusive", () => {
    expect(PORCENTAJE_MIN).toBe(5);
    expect(PORCENTAJE_MAX).toBe(50);
    expect(esPorcentajeValido(5)).toBe(true);
    expect(esPorcentajeValido(50)).toBe(true);
    expect(esPorcentajeValido(27)).toBe(true);
  });

  it("rechaza fuera de rango, decimales y basura", () => {
    for (const invalido of [4, 51, 0, -5, 10.5, NaN, null, undefined, "10", {}, []]) {
      expect(esPorcentajeValido(invalido), `valor: ${invalido}`).toBe(false);
    }
  });
});
