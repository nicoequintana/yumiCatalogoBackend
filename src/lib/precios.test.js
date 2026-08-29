import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import {
  ESTADOS_PRECIO,
  calcularPrecio,
  redondearAEntero,
  estadoDePrecio,
} from "./precios.js";

/**
 * El cálculo de precio a partir de costo × coeficiente.
 *
 * ⚠️ Este set de casos es ESPEJO de `frontend/src/utils/precios.test.js`. Los
 * dos repos se publican por separado, así que el módulo está duplicado a mano
 * (mismo criterio que `lib/slug.js` ↔ `utils/slug.js`): si divergen, el admin
 * ve en pantalla un precio distinto del que el backend va a escribir.
 */
describe("redondearAEntero", () => {
  it("redondea al peso más cercano", () => {
    expect(redondearAEntero(new Decimal("6303.75")).toString()).toBe("6304");
    expect(redondearAEntero(new Decimal("29733.20")).toString()).toBe("29733");
    expect(redondearAEntero(new Decimal("16810")).toString()).toBe("16810");
  });

  // Medio peso exacto va HACIA ARRIBA. Es la convención comercial y la que
  // usa el resto del sistema; fijarla acá evita que un cambio de modo de
  // redondeo de Decimal la mueva sin que nadie lo note.
  it("el medio peso exacto redondea hacia arriba", () => {
    expect(redondearAEntero(new Decimal("6457.50")).toString()).toBe("6458");
    expect(redondearAEntero(new Decimal("0.5")).toString()).toBe("1");
  });

  it("deja quieto un valor que ya es entero", () => {
    expect(redondearAEntero(new Decimal("20500")).toString()).toBe("20500");
  });
});

describe("calcularPrecio", () => {
  // La tabla que se aprobó en el diseño. Es el contrato de la feature: si
  // alguno de estos cambia, cambió el precio de venta del catálogo.
  const casos = [
    { costo: "14504", coeficiente: "2.05", esperado: "29733" },
    { costo: "10000", coeficiente: "2.05", esperado: "20500" },
    { costo: "8200", coeficiente: "2.05", esperado: "16810" },
    { costo: "3150", coeficiente: "2.05", esperado: "6458" },
    { costo: "22900", coeficiente: "2.05", esperado: "46945" },
    // El caso que motivó el cambio de regla (29/08/2026).
    { costo: "3075", coeficiente: "2.05", esperado: "6304" },
  ];

  for (const { costo, coeficiente, esperado } of casos) {
    it(`${costo} × ${coeficiente} = ${esperado}`, () => {
      expect(calcularPrecio(costo, coeficiente).toString()).toBe(esperado);
    });
  }

  it("con coeficiente 1 devuelve el costo tal cual", () => {
    expect(calcularPrecio("14504", "1").toString()).toBe("14504");
    expect(calcularPrecio("20500", "1").toString()).toBe("20500");
  });

  // Nunca con float: `14504 * 2.05` en punto flotante da 29733.200000000004.
  // Con redondeo al entero esa basura ya no cambia el resultado, pero un valor
  // que caiga sobre el medio peso exacto sí se vuelve sensible al modo de
  // redondeo. Ver `utils/precios.js` del frontend, que no tiene Decimal y
  // resuelve lo mismo con aritmética entera.
  it("no arrastra error de punto flotante", () => {
    expect(calcularPrecio(10000, 2.05).toString()).toBe("20500");
    expect(calcularPrecio(3150, 2.05).toString()).toBe("6458");
  });

  it("acepta Decimal, string y number sin cambiar el resultado", () => {
    const esperado = "29733";
    expect(calcularPrecio(new Decimal("14504"), new Decimal("2.05")).toString()).toBe(esperado);
    expect(calcularPrecio("14504", "2.05").toString()).toBe(esperado);
    expect(calcularPrecio(14504, 2.05).toString()).toBe(esperado);
  });

  // Sin uno de los dos no hay cuenta que hacer. Devolver 0 sería peor que
  // devolver null: un 0 se escribiría como precio.
  it("devuelve null si falta el costo o el coeficiente", () => {
    expect(calcularPrecio(null, "2.05")).toBeNull();
    expect(calcularPrecio("14504", null)).toBeNull();
    expect(calcularPrecio(undefined, undefined)).toBeNull();
  });

  it("devuelve null ante valores no positivos", () => {
    expect(calcularPrecio("0", "2.05")).toBeNull();
    expect(calcularPrecio("14504", "0")).toBeNull();
    expect(calcularPrecio("-100", "2.05")).toBeNull();
  });
});

describe("estadoDePrecio", () => {
  it("es SIN_COSTO cuando falta costo o coeficiente", () => {
    expect(estadoDePrecio({ precio: "12000", costo: null, coeficiente: "2.05" })).toBe(
      ESTADOS_PRECIO.SIN_COSTO,
    );
    expect(estadoDePrecio({ precio: "12000", costo: "5000", coeficiente: null })).toBe(
      ESTADOS_PRECIO.SIN_COSTO,
    );
  });

  it("es AL_DIA cuando el precio publicado coincide con el cálculo", () => {
    expect(estadoDePrecio({ precio: "29733", costo: "14504", coeficiente: "2.05" })).toBe(
      ESTADOS_PRECIO.AL_DIA,
    );
  });

  it("es DIFIERE cuando el precio publicado es otro", () => {
    // Subió el costo y todavía no se aplicó.
    expect(estadoDePrecio({ precio: "29733", costo: "15200", coeficiente: "2.05" })).toBe(
      ESTADOS_PRECIO.DIFIERE,
    );
    // El admin pisó el precio a mano: también DIFIERE, y está bien que así sea.
    expect(estadoDePrecio({ precio: "18900", costo: "10000", coeficiente: "2.05" })).toBe(
      ESTADOS_PRECIO.DIFIERE,
    );
  });

  // `Decimal("20500")` y `Decimal("20500.00")` son el mismo dinero. Comparar
  // con `===` sobre strings los daría por distintos y marcaría DIFIERE un
  // producto que está al día.
  it("compara por valor, no por representación", () => {
    expect(estadoDePrecio({ precio: "20500.00", costo: "10000", coeficiente: "2.05" })).toBe(
      ESTADOS_PRECIO.AL_DIA,
    );
  });
});
