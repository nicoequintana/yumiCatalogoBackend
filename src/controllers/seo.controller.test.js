import { describe, expect, it, vi } from "vitest";

// `seo.controller.js` importa `lib/prisma.js` en el módulo, que instancia un
// adapter de conexión real. Se mockea igual que en `og.routes.paginas.test.js`
// para poder importar el archivo sin una base real detrás — `cuerpoHome` es
// una función pura, no toca Prisma.
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: { findMany: vi.fn(), findUnique: vi.fn() },
    categoria: { findMany: vi.fn() },
  },
}));

const { cuerpoHome } = await import("./seo.controller.js");

/**
 * Guard de la regla de cloaking sobre el manifiesto (Task 19, 05/09/2026).
 *
 * El bloque del manifiesto se dejó de montar en `Catalogo.jsx` — invisible
 * para una persona. Si `cuerpoHome` siguiera emitiéndolo, Googlebot recibiría
 * un `<h2>El Manifiesto YIMA</h2>` con su párrafo que ninguna persona ve: es
 * la definición exacta de cloaking, y el propio archivo lo advertía antes de
 * este fix.
 */
describe("cuerpoHome — el manifiesto no viaja al crawler", () => {
  it("el cuerpo del crawler NO lleva el manifiesto", () => {
    const cuerpo = cuerpoHome([], "https://yima-productos.com");

    expect(cuerpo).not.toContain("Manifiesto");
    expect(cuerpo).not.toContain("No vendemos productos");
  });

  it("el cuerpo del crawler lleva el h1, el párrafo y el CTA del hero, idénticos a Catalogo.jsx", () => {
    // El <h1> tiene que estar en los dos lados y ser el MISMO string.
    const cuerpo = cuerpoHome([], "https://yima-productos.com");

    expect(cuerpo).toContain("<h1>Objetos singulares que transforman tu cotidiano.</h1>");
    expect(cuerpo).toContain(
      "<p>Una selección táctil y funcional para el bienestar de la casa, la pausa y los rituales de todos los días. Cada pieza, elegida una por una.</p>",
    );
    expect(cuerpo).toContain('<a href="https://yima-productos.com/coleccion">Ver todo el catálogo</a>');
    expect(cuerpo).not.toContain("Descubrí cosas que te hacen la vida");
  });
});

/**
 * Las señales de confianza salieron del hero (rediseño 13/09/2026): envíos y
 * WhatsApp viven solo en las tarjetas de `Confianza`. Si el crawler siguiera
 * recibiendo la lista, vería un bloque que ninguna persona ve.
 */
describe("cuerpoHome — sin señales de confianza, en el orden del DOM", () => {
  it("no emite la lista de señales del hero viejo", () => {
    const cuerpo = cuerpoHome([], "https://yima-productos.com");

    expect(cuerpo).not.toContain("<ul>");
    expect(cuerpo).not.toContain("Productos seleccionados");
    expect(cuerpo).not.toContain("Para vos o para regalar");
  });

  it("el hero va antes de los destacados, como en el DOM de la home", () => {
    const destacados = [1, 2, 3, 4].map((id) => ({
      id,
      nombre: `Destacado ${id}`,
      precio: { toString: () => "1000" },
    }));
    const cuerpo = cuerpoHome(destacados, "https://yima-productos.com");

    expect(cuerpo).toContain("Hallazgos del día");
    expect(cuerpo.indexOf("<h1>")).toBeLessThan(cuerpo.indexOf("Hallazgos del día"));
  });
});
