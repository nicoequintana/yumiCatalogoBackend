import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Real-DB integration test (NOT mocked) for the case-insensitive `search`
 * filter added in `products.controller.js` (`construirFiltrosListado`).
 *
 * Why this exists: every other test in this repo mocks `prisma`, so none of
 * them can actually prove whether SQL Server's `contains` matches
 * case-insensitively — they only assert the shape of the `where` clause
 * Prisma receives, not what the real database does with it. This file talks
 * to the real dev SQL Server via the same `prisma` client/adapter the app
 * uses (`src/lib/prisma.js`, driven by `DATABASE_URL` in `.env`), the same
 * way this was manually verified during Sprint 3 Task 2's implementation:
 *
 *   1. `SELECT CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS NVARCHAR(200))`
 *      returned `SQL_Latin1_General_CP1_CI_AS` (CI = case-insensitive) against
 *      the `aura` dev database.
 *   2. A product created with a mixed-case name was found via
 *      `{ contains: <all-lowercase substring> }` with NO `mode` option.
 *   3. Passing `mode: "insensitive"` to the same filter THREW
 *      `Unknown argument mode. Did you mean lte?` — confirming the mssql
 *      connector doesn't support it at all.
 *
 * This test re-proves point 2 automatically, against whatever DB
 * `DATABASE_URL` points to right now, instead of relying on a one-time
 * manual run and a comment nobody can re-verify without redoing the probe by
 * hand. It self-skips (does not fail the suite) when no real DB is reachable
 * — e.g. a future CI environment without the dev SQL Server container —
 * since this repo has no prior convention for DB-gated tests and `npm test`
 * must stay runnable everywhere. Locally, with the dev container up (as it
 * is for this project), it always runs for real.
 */

let prisma;
let dbDisponible = false;
let productoId;

const NOMBRE_MIXED_CASE = "ZzIntegrationCollationTestXyZ";
const SKU_TEST = `TEST-COLLATION-INTEGRATION-${Date.now()}`;

beforeAll(async () => {
  try {
    ({ prisma } = await import("../lib/prisma.js"));
    await prisma.$queryRawUnsafe("SELECT 1 AS ok");
    dbDisponible = true;

    const producto = await prisma.product.create({
      data: {
        nombre: NOMBRE_MIXED_CASE,
        descripcion: "Producto de prueba para el test de integración de collation.",
        precio: "1.00",
        sku: SKU_TEST,
        visibleEnCatalogo: true,
      },
    });
    productoId = producto.id;
  } catch {
    // No real DB reachable (e.g. CI without the dev SQL Server container) —
    // tests below skip via `dbDisponible` instead of failing the suite.
    dbDisponible = false;
  }
});

afterAll(async () => {
  if (dbDisponible && productoId) {
    await prisma.product.delete({ where: { id: productoId } }).catch(() => {});
  }
  await prisma?.$disconnect().catch(() => {});
});

describe("search filter — case sensitivity contra SQL Server real", () => {
  it("encuentra un nombre mixed-case buscando en minúscula (contains, sin mode)", async () => {
    if (!dbDisponible) {
      console.warn("[integration] DB real no disponible, test omitido (no falla la suite).");
      return;
    }

    const busqueda = NOMBRE_MIXED_CASE.toLowerCase();
    const resultados = await prisma.product.findMany({
      where: { nombre: { contains: busqueda } },
    });

    expect(resultados.some((p) => p.id === productoId)).toBe(true);
  });

  it("mode: 'insensitive' no es soportado por el conector mssql (confirma por qué no se usa)", async () => {
    if (!dbDisponible) {
      console.warn("[integration] DB real no disponible, test omitido (no falla la suite).");
      return;
    }

    await expect(
      prisma.product.findMany({
        where: { nombre: { contains: "x", mode: "insensitive" } },
      }),
    ).rejects.toThrow();
  });
});
