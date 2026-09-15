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
  repartirPrecioCombo,
  condicionComboVigente,
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

  it("rechaza un productId no numérico", () => {
    const errores = validarComposicion([
      { productId: "abc", cantidad: 1 },
      { productId: 2, cantidad: 1 },
    ]);
    expect(errores).toEqual(["Cada producto necesita un `productId` válido."]);
  });

  it("rechaza un productId fraccionario", () => {
    const errores = validarComposicion([
      { productId: 1.5, cantidad: 1 },
      { productId: 2, cantidad: 1 },
    ]);
    expect(errores).toEqual(["Cada producto necesita un `productId` válido."]);
  });

  it("rechaza un productId cero o negativo", () => {
    expect(
      validarComposicion([
        { productId: 0, cantidad: 1 },
        { productId: 2, cantidad: 1 },
      ]),
    ).toEqual(["Cada producto necesita un `productId` válido."]);
    expect(
      validarComposicion([
        { productId: -1, cantidad: 1 },
        { productId: 2, cantidad: 1 },
      ]),
    ).toEqual(["Cada producto necesita un `productId` válido."]);
  });

  it("rechaza un productId ausente", () => {
    const errores = validarComposicion([{ cantidad: 1 }, { productId: 2, cantidad: 1 }]);
    expect(errores).toEqual(["Cada producto necesita un `productId` válido."]);
  });

  it("rechaza un productId fuera del rango entero seguro (mismo gotcha que 1e21 en `?campania=`)", () => {
    const errores = validarComposicion([
      { productId: 1e21, cantidad: 1 },
      { productId: 2, cantidad: 1 },
    ]);
    expect(errores).toEqual(["Cada producto necesita un `productId` válido."]);
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

describe("repartirPrecioCombo", () => {
  function sumaFilas(filas) {
    return filas.reduce((total, fila) => total + Number(fila.precioUnitario) * fila.cantidad, 0);
  }

  it("r = 0: reparte sin ajuste cuando la división es exacta", () => {
    // separado 15000; T = 13500; u = 4500 c/u; 4500*2 + 4500 = 13500.
    const filas = repartirPrecioCombo(
      [
        { productId: 1, precio: 5000, cantidad: 2 },
        { productId: 2, precio: 5000, cantidad: 1 },
      ],
      10,
    );
    expect(filas).toEqual([
      { productId: 1, precioUnitario: "4500", precioListaUnitario: "5000", cantidad: 2 },
      { productId: 2, precioUnitario: "4500", precioListaUnitario: "5000", cantidad: 1 },
    ]);
  });

  it("r = -1, ejemplo de la spec: lámpara $10.003 x2 + mesa $25.000 al 15 % ajusta la mesa", () => {
    // separado 45006; T = 38255,1 -> 38255. u_lámpara = 8502,55 -> 8503;
    // u_mesa = 21250. 8503*2 + 21250 = 38256 -> r = -1.
    const filas = repartirPrecioCombo(
      [
        { productId: 1, precio: 10003, cantidad: 2 },
        { productId: 2, precio: 25000, cantidad: 1 },
      ],
      15,
    );
    expect(filas).toEqual([
      { productId: 1, precioUnitario: "8503", precioListaUnitario: "10003", cantidad: 2 },
      { productId: 2, precioUnitario: "21249", precioListaUnitario: "25000", cantidad: 1 },
    ]);
    expect(sumaFilas(filas)).toBe(38255);
  });

  it("con varios items de cantidad 1, el ajuste va al de MAYOR precio de lista", () => {
    // separado 4006; T = 3405,1 -> 3405. u = 853 + 1700 + 853 = 3406 -> r = -1.
    const filas = repartirPrecioCombo(
      [
        { productId: 1, precio: 1003, cantidad: 1 },
        { productId: 2, precio: 2000, cantidad: 1 },
        { productId: 3, precio: 1003, cantidad: 1 },
      ],
      15,
    );
    expect(filas.map((f) => f.precioUnitario)).toEqual(["853", "1699", "853"]);
    expect(sumaFilas(filas)).toBe(3405);
  });

  it("r = +1 sin ningún item de cantidad 1: parte en dos filas el de mayor precio de lista", () => {
    // separado 39995; T = 34795,65 -> 34796. u_1 = 8699,13 -> 8699;
    // u_2 = 4349,13 -> 4349. 8699*3 + 4349*2 = 34795 -> r = +1.
    const filas = repartirPrecioCombo(
      [
        { productId: 1, precio: 9999, cantidad: 3 },
        { productId: 2, precio: 4999, cantidad: 2 },
      ],
      13,
    );
    expect(filas).toEqual([
      { productId: 1, precioUnitario: "8700", precioListaUnitario: "9999", cantidad: 1 },
      { productId: 1, precioUnitario: "8699", precioListaUnitario: "9999", cantidad: 2 },
      { productId: 2, precioUnitario: "4349", precioListaUnitario: "4999", cantidad: 2 },
    ]);
    expect(sumaFilas(filas)).toBe(34796);
  });

  it("comboCantidad multiplica la cantidad de cada fila, sin tocar el precio unitario", () => {
    const filas = repartirPrecioCombo(
      [
        { productId: 1, precio: 10003, cantidad: 2 },
        { productId: 2, precio: 25000, cantidad: 1 },
      ],
      15,
      3,
    );
    expect(filas).toEqual([
      { productId: 1, precioUnitario: "8503", precioListaUnitario: "10003", cantidad: 6 },
      { productId: 2, precioUnitario: "21249", precioListaUnitario: "25000", cantidad: 3 },
    ]);
    expect(sumaFilas(filas)).toBe(38255 * 3);
  });

  it("rechaza en vez de dejar una fila en $0: dos productos de $1 al 50 %", () => {
    // separado 2; T = 1. u = 0,5 -> 1 c/u = 2 -> r = -1; ninguna fila soporta 1 - 1 > 0.
    expect(() =>
      repartirPrecioCombo(
        [
          { productId: 1, precio: 1, cantidad: 1 },
          { productId: 2, precio: 1, cantidad: 1 },
        ],
        50,
      ),
    ).toThrow("No se puede repartir el precio del combo sin dejar una fila en $0.");
  });
});

describe("condicionComboVigente", () => {
  it("exige activo: true siempre", () => {
    const where = condicionComboVigente(new Date("2026-09-14T15:00:00.000Z"));
    expect(where.activo).toBe(true);
  });

  it("SIEMPRE vigente entra por el primer brazo del OR, sin mirar campañas", () => {
    const where = condicionComboVigente(new Date("2026-09-14T15:00:00.000Z"));
    expect(where.OR[0]).toEqual({ vigencia: "SIEMPRE" });
  });

  it("CAMPANIA exige una campaña HABILITADA y en fecha", () => {
    const where = condicionComboVigente(new Date("2026-09-14T15:00:00.000Z"));
    expect(where.OR[1].campanias.some.campania.estado).toBe("HABILITADA");
  });

  it("el borde de las 21:00 del último día: hasta = medianoche del día X sigue vigente a las 20:59 ART (23:59 UTC) de X, pero no al día siguiente", () => {
    // hasta = medianoche argentina del 14/09 = 2026-09-14T03:00:00.000Z
    const hasta = new Date("2026-09-14T03:00:00.000Z");
    // 20:59 ART del 14/09 = 23:59 UTC del 14/09: la campaña sigue en fecha.
    const finDelDia = condicionComboVigente(new Date("2026-09-14T23:59:00.000Z"));
    const enFecha = finDelDia.OR[1].campanias.some.campania;
    expect(enFecha.hasta.gte.getTime()).toBeLessThanOrEqual(hasta.getTime());

    // Al día siguiente (15/09, cualquier hora) la medianoche de HOY ya pasó
    // el `hasta` de una campaña que terminó el 14: el `gte` de esa consulta
    // usa la medianoche del 15, posterior a `hasta`.
    const diaSiguiente = condicionComboVigente(new Date("2026-09-15T15:00:00.000Z"));
    const medianocheDelDiaSiguiente = diaSiguiente.OR[1].campanias.some.campania.hasta.gte;
    expect(medianocheDelDiaSiguiente.getTime()).toBeGreaterThan(hasta.getTime());
  });
});
