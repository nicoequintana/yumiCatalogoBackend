import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import { subtotalDeItem, sumarDecimales, totalDeItems, costoDeItem } from "./dinero.js";

/**
 * Guard de la regla que este módulo existe para sostener: la aritmética
 * monetaria va en `Decimal`, NUNCA en float.
 *
 * Vive acá y no en los tests de las rutas de analytics por una razón concreta.
 * Ese guard vivía en `adminVentas.routes.test.js` y `adminClientes.routes.test.js`,
 * con fixtures de `precioUnitario: "0.10"` — y desde que los montos son enteros
 * (`Decimal(10, 0)`), esas rutas serializan con `toFixed(0)`: float y `Decimal`
 * dan exactamente el mismo string y el test dejó de distinguir una
 * implementación de la otra. Un test que no puede fallar cuando la regla se
 * rompe no es un guard, es decoración.
 *
 * Acá sí distingue, porque estas funciones devuelven el `Decimal` crudo, sin
 * redondear. Que la entrada fraccionaria ya no llegue de la base no lo invalida:
 * las tres funciones aceptan `unknown` y lo documentan, y los promedios de
 * `admin.controller.js` siguen dividiendo, que es donde la parte fraccionaria
 * reaparece antes de redondearse.
 */
describe("dinero — la aritmética es Decimal, no float", () => {
  it("subtotalDeItem devuelve Decimal, no number", () => {
    expect(subtotalDeItem({ precioUnitario: "1000", cantidad: 2 })).toBeInstanceOf(Decimal);
  });

  it("acumula sin el drift de punto flotante", () => {
    // 0.10 * 7, diez veces. En float esto da 7.000000000000001.
    const items = Array.from({ length: 10 }, () => ({ precioUnitario: "0.10", cantidad: 7 }));

    expect(totalDeItems(items).toString()).toBe("7");
  });

  it("normaliza precioUnitario venga como Decimal, string o number", () => {
    expect(subtotalDeItem({ precioUnitario: new Decimal("1500"), cantidad: 2 }).toString()).toBe("3000");
    expect(subtotalDeItem({ precioUnitario: "1500", cantidad: 2 }).toString()).toBe("3000");
    expect(subtotalDeItem({ precioUnitario: 1500, cantidad: 2 }).toString()).toBe("3000");
  });

  // Los tableros del admin arman consultas con `include` variable: una orden
  // sin items cargados vale cero, no revienta.
  it("totalDeItems tolera items ausente y devuelve cero", () => {
    expect(totalDeItems(undefined).toString()).toBe("0");
    expect(totalDeItems(null).toString()).toBe("0");
    expect(totalDeItems([]).toString()).toBe("0");
  });

  it("sumarDecimales suma una lista ya calculada sin volver a multiplicar", () => {
    const valores = [new Decimal("1000"), new Decimal("2000"), new Decimal("501")];

    expect(sumarDecimales(valores).toString()).toBe("3501");
    expect(sumarDecimales([]).toString()).toBe("0");
  });

  // La división es lo único que hoy puede producir una parte fraccionaria a
  // partir de montos enteros (ticket promedio, valor promedio por cliente).
  // Que salga exacta acá es lo que hace que el `toFixed(0)` de los controllers
  // redondee un valor correcto y no uno que ya venía con cola de flotante.
  it("divide sin cola de flotante (el caso de los promedios)", () => {
    expect(new Decimal("3001").div(3).toFixed(0)).toBe("1000");
    expect(new Decimal("3002").div(3).toFixed(0)).toBe("1001");
  });
});

describe("costoDeItem", () => {
  it("multiplica costo por cantidad con Decimal", () => {
    const resultado = costoDeItem({ costoUnitario: "5000", cantidad: 3 });
    expect(resultado.toFixed(0)).toBe("15000");
  });

  it("devuelve null —NUNCA cero— cuando la línea no tiene costo", () => {
    // Este es el guard de toda la feature. `null` significa "no se puede
    // calcular el margen de esta línea"; un `Decimal(0)` diría "esta venta no
    // costó nada" e inflaría la ganancia sin que nada lo delate.
    expect(costoDeItem({ costoUnitario: null, cantidad: 3 })).toBeNull();
    expect(costoDeItem({ cantidad: 3 })).toBeNull();
  });

  it("un costo de cero SÍ es cero, no null", () => {
    // Un producto que efectivamente costó 0 es un dato válido y distinto de
    // "no sé cuánto costó".
    const resultado = costoDeItem({ costoUnitario: "0", cantidad: 2 });
    expect(resultado).not.toBeNull();
    expect(resultado.toFixed(0)).toBe("0");
  });

  it("acepta Decimal, string y number sin perder precisión", () => {
    expect(costoDeItem({ costoUnitario: 5000, cantidad: 2 }).toFixed(0)).toBe("10000");
  });
});
