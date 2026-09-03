import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import { cuerpoProducto } from "./seo.cuerpo.js";

/**
 * Guard de la regla de cloaking sobre el PRECIO.
 *
 * Servirle a un buscador contenido distinto del que ve una persona se penaliza
 * con desindexación. Con una promoción activa, la ficha muestra el precio
 * tachado, el efectivo y el porcentaje: este HTML tiene que mostrar lo mismo.
 *
 * Existe además por un motivo concreto: la primera versión pasó 1503 tests en
 * verde y tiró un 500 en el endpoint real (`decimal.toFixed is not a function`)
 * porque el precio efectivo viajaba como string y `formatearMonto` espera un
 * `Decimal`. Era exactamente la regla 3 del proyecto — la suite verde no
 * alcanza para un cambio de contrato.
 */

function producto(extra = {}) {
  return {
    id: 7,
    nombre: "Termo mate",
    descripcion: "Un termo",
    precio: new Decimal("20000"),
    stock: 4,
    caracteristicas: [],
    listas: [],
    especificaciones: [],
    ...extra,
  };
}

describe("cuerpoProducto — el precio que ve el crawler", () => {
  it("sin promoción muestra un solo precio, formateado", () => {
    expect(cuerpoProducto(producto())).toContain("<p>Precio: $20.000</p>");
  });

  it("con promoción muestra el tachado, el efectivo y el porcentaje", () => {
    // Los tres, como en la ficha. Servirle solo el de lista sería mostrarle a
    // Google un precio que en la página no existe; solo el efectivo, ocultarle
    // que hay oferta.
    const html = cuerpoProducto(producto(), {
      descuento: { porcentaje: 15, precioEfectivo: new Decimal("17000") },
    });

    expect(html).toContain("<s>$20.000</s>");
    expect(html).toContain("$17.000");
    expect(html).toContain("15% OFF");
  });

  it("acepta el precio efectivo como Decimal", () => {
    // El bug real: `formatearMonto` llama a `.toFixed(0)`, que un string no
    // tiene. Pasaba por unit tests que nunca ejercitaban esta rama.
    expect(() =>
      cuerpoProducto(producto(), {
        descuento: { porcentaje: 15, precioEfectivo: new Decimal("17000") },
      }),
    ).not.toThrow();
  });

  it("acepta el precio efectivo como STRING, sin romper", () => {
    // Defensa en profundidad: el llamador no debería tener que saber en qué
    // forma viaja el número para que el HTML del crawler no explote.
    const html = cuerpoProducto(producto(), {
      descuento: { porcentaje: 15, precioEfectivo: "17000" },
    });

    expect(html).toContain("$17.000");
  });

  it("el precio del crawler usa el MISMO formato que la ficha", () => {
    // Miles con punto y sin decimales, como `formatPrecio` del frontend.
    expect(cuerpoProducto(producto({ precio: new Decimal("1250000") }))).toContain("$1.250.000");
  });
});
