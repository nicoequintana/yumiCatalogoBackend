import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { escaparLike } from "../lib/escaparLike.js";

/**
 * Test de integración con DB REAL (no mockeada) para el escape de los
 * metacaracteres de LIKE del filtro `search` (`construirFiltrosListado`), a
 * través de `lib/escaparLike.js`.
 *
 * Por qué existe: el resto de los tests mockean `prisma`, así que solo pueden
 * afirmar la FORMA del `where` que recibe Prisma, no lo que la base hace con él.
 * Este habla con el SQL Server de desarrollo por el mismo cliente/adaptador que
 * la app y demuestra dos cosas contra la base real:
 *
 *   1. Sin escape, `contains: "50%OFF"` trata el `%` como comodín y matchea un
 *      producto cuyo nombre NO contiene "50%OFF" literal — la fuga que motiva el
 *      escape.
 *   2. Con `escaparLike`, el mismo término matchea únicamente el literal, porque
 *      la técnica de clase de caracteres (`%` -> `[%]`) neutraliza el comodín
 *      SIN una cláusula ESCAPE (que el conector mssql de `contains` no emite).
 *
 * Se auto-omite (no falla la suite) cuando no hay DB real alcanzable, mismo
 * criterio que `products.controller.integration.test.js`.
 */

let prisma;
let dbDisponible = false;
const ids = [];

const PREF = `LIKE-ESC-${Date.now()}`;
const CON_LITERAL = "50%OFF"; // el nombre contiene el literal "50%OFF"
const SIN_LITERAL = "50XOFF"; // matchearía "50%OFF" solo si el % fuera comodín

const TIMEOUT_PREPARACION_MS = 8000;

function conTimeout(promesa, ms, mensaje) {
  let timer;
  return Promise.race([
    promesa.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(mensaje)), ms);
    }),
  ]);
}

async function crear(nombre) {
  const producto = await prisma.product.create({
    data: {
      nombre: `${PREF} ${nombre}`,
      descripcion: "Producto de prueba para el escape de LIKE.",
      precio: "1",
      sku: `${PREF}-${nombre}`,
      visibleEnCatalogo: true,
    },
  });
  ids.push(producto.id);
  return producto.id;
}

async function buscar(termino) {
  const resultados = await prisma.product.findMany({
    where: { AND: [{ sku: { startsWith: PREF } }, { nombre: { contains: termino } }] },
    select: { sku: true },
  });
  return resultados.map((r) => r.sku).sort();
}

let idConLiteral;
let idSinLiteral;

beforeAll(async () => {
  try {
    await conTimeout(
      (async () => {
        ({ prisma } = await import("../lib/prisma.js"));
        await prisma.$queryRawUnsafe("SELECT 1 AS ok");
        idConLiteral = await crear(CON_LITERAL);
        idSinLiteral = await crear(SIN_LITERAL);
      })(),
      TIMEOUT_PREPARACION_MS,
      `La preparación contra la DB real tardó más de ${TIMEOUT_PREPARACION_MS}ms.`,
    );
    dbDisponible = true;
  } catch {
    dbDisponible = false;
  }
});

afterAll(async () => {
  if (dbDisponible) {
    for (const id of ids) await prisma.product.delete({ where: { id } }).catch(() => {});
  }
  await prisma?.$disconnect().catch(() => {});
});

describe("escape de LIKE en search — contra SQL Server real", () => {
  it("sin escape, el % actúa como comodín y matchea de más (la fuga)", async () => {
    if (!dbDisponible) {
      console.warn("[integration] DB real no disponible, test omitido (no falla la suite).");
      return;
    }

    const skus = await buscar(CON_LITERAL); // "50%OFF" crudo
    // El comodín hace que "50%OFF" matchee también "...50XOFF".
    expect(skus).toContain(`${PREF}-${SIN_LITERAL}`);
  });

  it("con escaparLike, el % matchea solo el literal", async () => {
    if (!dbDisponible) {
      console.warn("[integration] DB real no disponible, test omitido (no falla la suite).");
      return;
    }

    const skus = await buscar(escaparLike(CON_LITERAL)); // "50[%]OFF"
    expect(skus).toEqual([`${PREF}-${CON_LITERAL}`]);
    expect(skus).not.toContain(`${PREF}-${SIN_LITERAL}`);
    expect(idConLiteral).toBeTypeOf("number");
    expect(idSinLiteral).toBeTypeOf("number");
  });
});
