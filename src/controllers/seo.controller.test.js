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

  it("el cuerpo del crawler SIGUE llevando el h1 del hero", () => {
    // El hero baja de lugar pero no desaparece: el <h1> tiene que seguir
    // estando en los dos lados, y ser el MISMO string.
    const cuerpo = cuerpoHome([], "https://yima-productos.com");

    expect(cuerpo).toContain("<h1>Descubrí cosas que te hacen la vida más fácil.</h1>");
  });
});
