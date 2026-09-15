import { describe, expect, it } from "vitest";
import {
  MIN_UNIDADES,
  MAX_UNIDADES,
  LARGO_MAX_FRASE,
  LARGO_MAX_NOMBRE,
  UMBRAL_QUEDAN_POCOS,
  VIGENCIAS,
  cuentasCombo,
  alcanzaCombo,
  disponibilidadCombo,
  validarComposicion,
} from "./combos.js";

describe("cuentasCombo", () => {
  it("suma los precios de lista y aplica el descuento redondeando al peso", () => {
    const items = [
      { precio: 10000, cantidad: 2 },
      { precio: 25000, cantidad: 1 },
    ];
    const cuentas = cuentasCombo(items, 15);
    expect(cuentas.precioSeparado.toString()).toBe("45000");
    // 45000 * 0.85 = 38250
    expect(cuentas.precioCombo.toString()).toBe("38250");
    expect(cuentas.ahorro.toString()).toBe("6750");
    expect(cuentas.unidades).toBe(3);
  });

  it("redondea el ,50 hacia arriba (ROUND_HALF_UP): 101 con 50 % = 50,50 -> 51", () => {
    const cuentas = cuentasCombo([{ precio: 101, cantidad: 1 }], 50);
    expect(cuentas.precioCombo.toString()).toBe("51");
    expect(cuentas.ahorro.toString()).toBe("50");
  });

  it("acepta el precio como string o como Decimal de Prisma", () => {
    const cuentas = cuentasCombo([{ precio: "10000", cantidad: 1 }, { precio: { toString: () => "5000" }, cantidad: 1 }], 10);
    expect(cuentas.precioSeparado.toString()).toBe("15000");
  });

  it("unidades cuenta cada cantidad, no cada fila", () => {
    const items = [
      { precio: 5000, cantidad: 2 },
      { precio: 8000, cantidad: 1 },
      { precio: 3000, cantidad: 3 },
    ];
    expect(cuentasCombo(items, 10).unidades).toBe(6);
  });
});

describe("alcanzaCombo", () => {
  it("es el mínimo de floor(stock / cantidad) entre los items", () => {
    const items = [
      { stock: 9, cantidad: 2 }, // alcanza para 4
      { stock: 4, cantidad: 1 }, // alcanza para 4
    ];
    expect(alcanzaCombo(items)).toBe(4);
  });

  it("un producto sin stock deja el combo en 0, nunca negativo", () => {
    const items = [
      { stock: 0, cantidad: 1 },
      { stock: 50, cantidad: 1 },
    ];
    expect(alcanzaCombo(items)).toBe(0);
  });

  it("un stock negativo heredado también da 0", () => {
    expect(alcanzaCombo([{ stock: -3, cantidad: 1 }])).toBe(0);
  });

  it("stock que no alcanza para ni una unidad de un item con cantidad > 1 da 0", () => {
    const items = [{ stock: 1, cantidad: 2 }];
    expect(alcanzaCombo(items)).toBe(0);
  });
});

describe("disponibilidadCombo", () => {
  it("disponible con todos visibles y alcanza >= 1; quedanPocos hasta el umbral", () => {
    const items = [
      { stock: 6, cantidad: 2, visibleEnCatalogo: true },
      { stock: 9, cantidad: 1, visibleEnCatalogo: true },
    ];
    expect(disponibilidadCombo(items)).toEqual({ alcanza: 3, disponible: true, quedanPocos: true });
  });

  it("con alcanza por encima del umbral no marca quedanPocos", () => {
    const items = [{ stock: 40, cantidad: 1, visibleEnCatalogo: true }];
    expect(disponibilidadCombo(items)).toEqual({ alcanza: 40, disponible: true, quedanPocos: false });
  });

  it("un producto oculto deja el combo no disponible aunque haya stock", () => {
    const items = [
      { stock: 10, cantidad: 1, visibleEnCatalogo: false },
      { stock: 10, cantidad: 1, visibleEnCatalogo: true },
    ];
    expect(disponibilidadCombo(items).disponible).toBe(false);
  });

  it("sin stock: no disponible y NO quedanPocos (el chip es Agotado, no Quedan 0)", () => {
    const items = [{ stock: 0, cantidad: 1, visibleEnCatalogo: true }];
    expect(disponibilidadCombo(items)).toEqual({ alcanza: 0, disponible: false, quedanPocos: false });
  });
});

describe("validarComposicion", () => {
  it("acepta una composición válida", () => {
    expect(validarComposicion([{ productId: 1, cantidad: 2 }, { productId: 2, cantidad: 1 }])).toEqual([]);
  });

  it(`rechaza menos de ${MIN_UNIDADES} unidades`, () => {
    const errores = validarComposicion([{ productId: 1, cantidad: 1 }]);
    expect(errores).toEqual([`Un combo necesita al menos ${MIN_UNIDADES} unidades entre todos sus productos.`]);
  });

  it(`rechaza más de ${MAX_UNIDADES} unidades`, () => {
    const errores = validarComposicion([{ productId: 1, cantidad: MAX_UNIDADES + 1 }]);
    expect(errores).toEqual([`Un combo admite como máximo ${MAX_UNIDADES} unidades entre todos sus productos.`]);
  });

  it("rechaza un producto duplicado", () => {
    const errores = validarComposicion([
      { productId: 1, cantidad: 1 },
      { productId: 1, cantidad: 1 },
    ]);
    expect(errores).toEqual(["Hay un producto repetido en el combo."]);
  });

  it("rechaza una cantidad menor a 1 o no entera", () => {
    const errores = validarComposicion([
      { productId: 1, cantidad: 0 },
      { productId: 2, cantidad: 1.5 },
    ]);
    expect(errores).toEqual(["Cada producto necesita una cantidad entera de al menos 1 unidad."]);
  });

  it("rechaza algo que no es un array", () => {
    expect(validarComposicion(null)).toEqual(["Enviá la lista de productos del combo."]);
  });
});

describe("constantes", () => {
  it("expone los límites acordados", () => {
    expect(MIN_UNIDADES).toBe(2);
    expect(MAX_UNIDADES).toBe(10);
    expect(LARGO_MAX_FRASE).toBe(140);
    expect(LARGO_MAX_NOMBRE).toBe(120);
    expect(UMBRAL_QUEDAN_POCOS).toBe(3);
    expect(VIGENCIAS).toEqual(["SIEMPRE", "CAMPANIA"]);
  });
});
