import { describe, expect, it } from "vitest";
import { agruparLineasOrden } from "./agruparLineasOrden.js";

function itemSuelto(extra = {}) {
  return {
    productId: 1,
    nombreProducto: "Silla",
    precioUnitario: "20000",
    cantidad: 1,
    comboId: null,
    comboNombre: null,
    comboCantidad: null,
    ...extra,
  };
}

function itemDeCombo(extra = {}) {
  return {
    productId: 2,
    nombreProducto: "Lámpara",
    precioUnitario: "8500",
    cantidad: 2,
    comboId: 3,
    comboNombre: "Kit Living Cálido",
    comboCantidad: 1,
    ...extra,
  };
}

describe("agruparLineasOrden", () => {
  it("una línea suelta queda como PRODUCTO, tal cual", () => {
    const grupos = agruparLineasOrden([itemSuelto()]);
    expect(grupos).toEqual([{ tipo: "PRODUCTO", item: itemSuelto() }]);
  });

  it("dos filas del mismo combo se agrupan en una línea COMBO", () => {
    const grupos = agruparLineasOrden([
      itemDeCombo(),
      itemDeCombo({ productId: 4, nombreProducto: "Mesa", precioUnitario: "21250", cantidad: 1 }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0]).toMatchObject({
      tipo: "COMBO",
      comboId: 3,
      comboNombre: "Kit Living Cálido",
      comboCantidad: 1,
      productos: [
        { nombreProducto: "Lámpara", cantidad: 2 },
        { nombreProducto: "Mesa", cantidad: 1 },
      ],
    });
    // total = 8500*2 + 21250*1 = 38250
    expect(grupos[0].total).toBe("38250");
  });

  it("un combo partido en dos filas del MISMO producto muestra ese producto una vez, con la cantidad sumada", () => {
    const grupos = agruparLineasOrden([
      itemDeCombo({ productId: 5, nombreProducto: "Almohadón", cantidad: 1, precioUnitario: "5000" }),
      itemDeCombo({ productId: 5, nombreProducto: "Almohadón", cantidad: 1, precioUnitario: "4999" }),
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].productos).toEqual([{ nombreProducto: "Almohadón", cantidad: 2 }]);
    expect(grupos[0].total).toBe("9999");
  });

  it("con comboCantidad 2, los productos se listan por UN combo y el total es el de los dos", () => {
    const grupos = agruparLineasOrden([
      itemDeCombo({ cantidad: 4, comboCantidad: 2 }),
      itemDeCombo({ productId: 4, nombreProducto: "Mesa", precioUnitario: "21250", cantidad: 2, comboCantidad: 2 }),
    ]);
    expect(grupos[0]).toMatchObject({
      comboCantidad: 2,
      productos: [
        { nombreProducto: "Lámpara", cantidad: 2 },
        { nombreProducto: "Mesa", cantidad: 1 },
      ],
      total: "76500", // 8500*4 + 21250*2
    });
  });

  it("combo y producto suelto conviven como líneas distintas", () => {
    const grupos = agruparLineasOrden([itemSuelto(), itemDeCombo()]);
    expect(grupos).toHaveLength(2);
    expect(grupos[0].tipo).toBe("PRODUCTO");
    expect(grupos[1].tipo).toBe("COMBO");
  });

  it("dos combos DISTINTOS en la misma orden dan dos líneas COMBO", () => {
    const grupos = agruparLineasOrden([
      itemDeCombo({ comboId: 3, comboNombre: "Kit Living" }),
      itemDeCombo({ comboId: 6, comboNombre: "Kit Dormitorio", productId: 9, nombreProducto: "Velador" }),
    ]);
    expect(grupos).toHaveLength(2);
    expect(grupos.map((g) => g.comboNombre)).toEqual(["Kit Living", "Kit Dormitorio"]);
  });
});
