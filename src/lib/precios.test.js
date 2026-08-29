import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import {
  ESTADOS_PRECIO,
  calcularPrecio,
  redondearACentenaArriba,
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
describe("redondearACentenaArriba", () => {
  it("sube al siguiente múltiplo de 100", () => {
    expect(redondearACentenaArriba(new Decimal("29733.20")).toString()).toBe("29800");
    expect(redondearACentenaArriba(new Decimal("6457.50")).toString()).toBe("6500");
    expect(redondearACentenaArriba(new Decimal("16810")).toString()).toBe("16900");
  });

  // El caso que rompe una implementación ingenua con `+ 100`: un valor que YA
  // es múltiplo de 100 tiene que quedarse donde está. Si subiera, cada
  // aplicación sucesiva le agregaría $100 al producto sin que nadie lo pida.
  it("deja quieto un valor que ya es múltiplo de 100", () => {
    expect(redondearACentenaArriba(new Decimal("20500")).toString()).toBe("20500");
    expect(redondearACentenaArriba(new Decimal("100")).toString()).toBe("100");
  });

  it("nunca devuelve un valor menor al recibido", () => {
    for (const valor of ["1", "99.99", "100.01", "12345.67"]) {
      const redondeado = redondearACentenaArriba(new Decimal(valor));
      expect(redondeado.gte(new Decimal(valor))).toBe(true);
    }
  });
});

describe("calcularPrecio", () => {
  // La tabla que se aprobó en el diseño. Es el contrato de la feature: si
  // alguno de estos cambia, cambió el precio de venta del catálogo.
  const casos = [
    { costo: "14504", coeficiente: "2.05", esperado: "29800" },
    { costo: "10000", coeficiente: "2.05", esperado: "20500" },
    { costo: "8200", coeficiente: "2.05", esperado: "16900" },
    { costo: "3150", coeficiente: "2.05", esperado: "6500" },
    { costo: "22900", coeficiente: "2.05", esperado: "47000" },
  ];

  for (const { costo, coeficiente, esperado } of casos) {
    it(`${costo} × ${coeficiente} = ${esperado}`, () => {
      expect(calcularPrecio(costo, coeficiente).toString()).toBe(esperado);
    });
  }

  it("con coeficiente 1 devuelve el costo redondeado", () => {
    expect(calcularPrecio("14504", "1").toString()).toBe("14600");
    expect(calcularPrecio("20500", "1").toString()).toBe("20500");
  });

  // Nunca con float: `14504 * 2.05` en punto flotante da 29733.200000000004, y
  // el día que un producto caiga justo sobre un múltiplo de 100 esa basura lo
  // empuja a la centena siguiente. Ver `utils/precios.js` del frontend, que no
  // tiene Decimal y resuelve lo mismo con aritmética entera.
  it("no arrastra error de punto flotante", () => {
    // 10000 × 2.05 es exactamente 20500: no puede terminar en 20600.
    expect(calcularPrecio(10000, 2.05).toString()).toBe("20500");
  });

  it("acepta Decimal, string y number sin cambiar el resultado", () => {
    const esperado = "29800";
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
    expect(estadoDePrecio({ precio: "29800", costo: "14504", coeficiente: "2.05" })).toBe(
      ESTADOS_PRECIO.AL_DIA,
    );
  });

  it("es DIFIERE cuando el precio publicado es otro", () => {
    // Subió el costo y todavía no se aplicó.
    expect(estadoDePrecio({ precio: "29800", costo: "15200", coeficiente: "2.05" })).toBe(
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
