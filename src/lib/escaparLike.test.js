import { describe, expect, it } from "vitest";
import { escaparLike } from "./escaparLike.js";

/**
 * `escaparLike` neutraliza los metacaracteres de LIKE de SQL Server envolviendo
 * cada uno en una clase de caracteres (`%` -> `[%]`), que es la única técnica de
 * escape que funciona SIN una cláusula ESCAPE — y el conector mssql de Prisma no
 * emite ninguna (ver el comentario de cabecera del módulo y la verificación
 * end-to-end en `products.search-like.integration.test.js`).
 */
describe("escaparLike", () => {
  it("escapa el comodín de porcentaje", () => {
    expect(escaparLike("50%OFF")).toBe("50[%]OFF");
  });

  it("escapa el comodín de guion bajo", () => {
    expect(escaparLike("a_b")).toBe("a[_]b");
  });

  it("escapa el corchete de apertura de una clase de caracteres", () => {
    expect(escaparLike("x[y")).toBe("x[[]y");
  });

  it("escapa varios metacaracteres en la misma pasada, sin re-escapar los corchetes que agrega", () => {
    expect(escaparLike("%_[")).toBe("[%][_][[]");
  });

  it("deja el backslash tal cual: sin cláusula ESCAPE es un caracter literal en LIKE", () => {
    // El backslash NO es un metacaracter de LIKE en SQL Server salvo que una
    // cláusula ESCAPE lo declare, y este conector no la emite (verificado).
    expect(escaparLike("a\\b")).toBe("a\\b");
  });

  it("no toca un término sin metacaracteres", () => {
    expect(escaparLike("bruma")).toBe("bruma");
  });

  it("devuelve la cadena vacía tal cual", () => {
    expect(escaparLike("")).toBe("");
  });
});
