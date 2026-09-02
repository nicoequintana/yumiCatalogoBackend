import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * `?orden=` — los ordenamientos del listado, que alimentan el selector
 * "Ordenar por" del panel del admin.
 *
 * Lo que esta suite fija:
 *
 *   1. **Cada criterio ordena en la BASE, no en memoria.** La tabla está
 *      paginada: ordenar del lado del cliente reordenaría solo la página que
 *      tocó, que es un ranking directamente falso. Es el mismo error que ya
 *      obligó a bajar `orden=vistas` al backend.
 *   2. **Todos desempatan por `id`.** Sin desempate, dos filas con el mismo
 *      precio (o el mismo stock, o cero fotos) pueden salir en distinto orden
 *      entre dos consultas, y entonces un producto aparece dos veces al pasar
 *      de página, o no aparece nunca. Es la falla más difícil de ver de todas
 *      las de este archivo.
 *   3. **Un valor desconocido cae al default**, nunca un 400: es un endpoint
 *      público de browse y un link viejo no tiene que romperse.
 *   4. **El orden no toca el `where`.** Ordenar no puede ampliar lo que se
 *      ve: la rama pública sigue escondiendo ocultos y agotados.
 */

const findManyMock = vi.fn();
const countMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findMany: (...args) => findManyMock(...args),
      findUnique: vi.fn(),
      update: vi.fn(),
      count: (...args) => countMock(...args),
    },
  },
}));
vi.mock("../services/googleDrive.service.js", () => ({}));
vi.mock("../services/cloudinary.service.js", () => ({}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

/** El `orderBy` con el que el controller consultó a Prisma. */
function orderByDeLaConsulta() {
  return findManyMock.mock.calls[0][0].orderBy;
}

beforeEach(() => {
  findManyMock.mockReset();
  countMock.mockReset();
  findManyMock.mockResolvedValue([]);
  countMock.mockResolvedValue(0);
});

describe("GET /api/products - ?orden=", () => {
  const esperados = {
    nombre: [{ nombre: "asc" }, { id: "asc" }],
    "nombre-desc": [{ nombre: "desc" }, { id: "asc" }],
    "precio-asc": [{ precio: "asc" }, { id: "asc" }],
    "precio-desc": [{ precio: "desc" }, { id: "asc" }],
    "stock-asc": [{ stock: "asc" }, { id: "asc" }],
    "stock-desc": [{ stock: "desc" }, { id: "asc" }],
    "fotos-asc": [{ fotos: { _count: "asc" } }, { id: "asc" }],
    "fotos-desc": [{ fotos: { _count: "desc" } }, { id: "asc" }],
    recientes: [{ createdAt: "desc" }, { id: "desc" }],
    vistas: [{ vistas: "desc" }, { id: "asc" }],
    // Los dos criterios de la pantalla de Costos y precios. Sus columnas son
    // NULLABLE, a diferencia de todas las de arriba: un producto sin costo
    // cargado ordena igual, agrupado en un extremo según cómo ubique los NULL
    // el connector.
    "costo-asc": [{ costo: "asc" }, { id: "asc" }],
    "costo-desc": [{ costo: "desc" }, { id: "asc" }],
    "coeficiente-asc": [{ coeficiente: "asc" }, { id: "asc" }],
    "coeficiente-desc": [{ coeficiente: "desc" }, { id: "asc" }],
  };

  for (const [valor, orderBy] of Object.entries(esperados)) {
    it(`ordena en la base con ?orden=${valor}`, async () => {
      await request(buildApp()).get(`/api/products?orden=${valor}`);

      expect(orderByDeLaConsulta()).toEqual(orderBy);
    });
  }

  it("desempata SIEMPRE por id, en todos los criterios", async () => {
    // Sin desempate la paginación es inestable: dos filas con el mismo valor
    // pueden salir en distinto orden entre página y página.
    for (const valor of Object.keys(esperados)) {
      findManyMock.mockClear();
      await request(buildApp()).get(`/api/products?orden=${valor}`);

      const orderBy = orderByDeLaConsulta();
      expect(orderBy.at(-1)).toHaveProperty("id");
    }
  });

  // El default es `recientes`. Era `merchandising` —un `orden` manual por
  // producto— hasta que se eliminó el 29/08/2026 por no usarse: en producción
  // los 80 productos estaban todos en 0, así que el criterio efectivo ya era
  // este mismo y la tienda no cambió de orden.
  it("cae a `recientes` con un valor desconocido", async () => {
    await request(buildApp()).get("/api/products?orden=inventado");

    expect(orderByDeLaConsulta()).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("cae a `recientes` sin el parámetro", async () => {
    await request(buildApp()).get("/api/products");

    expect(orderByDeLaConsulta()).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("no amplía lo que ve un anónimo: el orden no toca el where", async () => {
    await request(buildApp()).get("/api/products?orden=precio-desc");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.visibleEnCatalogo).toBe(true);
    expect(where.stock).toEqual({ gt: 0 });
  });

  it("compone con la búsqueda sin pisarla", async () => {
    await request(buildApp()).get("/api/products?orden=nombre&search=bruma");

    const { where, orderBy } = findManyMock.mock.calls[0][0];
    expect(orderBy).toEqual([{ nombre: "asc" }, { id: "asc" }]);
    expect(where.OR).toBeDefined();
  });

  it("catalogo agrupa por estado de publicación: visibles+destacados, catálogo, sin stock, ocultos", async () => {
    await request(buildApp()).get("/api/products?orden=catalogo");

    // Columnas puras, sin expresiones: es la aproximación paginable de los
    // cuatro grupos. `stock: "desc"` es lo que manda los agotados al fondo de
    // los visibles sin SQL crudo — a cambio, dentro de cada grupo se ordena
    // por cantidad de stock, no por recientes.
    expect(orderByDeLaConsulta()).toEqual([
      { visibleEnCatalogo: "desc" },
      { destacado: "desc" },
      { stock: "desc" },
      { id: "desc" },
    ]);
  });

  it.each([
    ["sku-asc", [{ sku: "asc" }, { id: "asc" }]],
    ["sku-desc", [{ sku: "desc" }, { id: "asc" }]],
    ["etiqueta-asc", [{ etiqueta: "asc" }, { id: "asc" }]],
    ["etiqueta-desc", [{ etiqueta: "desc" }, { id: "asc" }]],
    ["categoria-asc", [{ categoria: { nombre: "asc" } }, { id: "asc" }]],
    ["categoria-desc", [{ categoria: { nombre: "desc" } }, { id: "asc" }]],
    ["visible-asc", [{ visibleEnCatalogo: "asc" }, { id: "asc" }]],
    ["visible-desc", [{ visibleEnCatalogo: "desc" }, { id: "asc" }]],
    ["destacado-asc", [{ destacado: "asc" }, { id: "asc" }]],
    ["destacado-desc", [{ destacado: "desc" }, { id: "asc" }]],
  ])(
    "el criterio de columna %s ordena en la base con desempate por id",
    async (criterio, esperado) => {
      // Los criterios de los encabezados clickeables del listado del admin.
      // `etiqueta` y `categoria` son nullables: los vacíos se agrupan en un
      // extremo, mismo comportamiento documentado que costo/coeficiente.
      await request(buildApp()).get(`/api/products?orden=${criterio}`);

      expect(orderByDeLaConsulta()).toEqual(esperado);
    },
  );

  it("catalogo no toca el default del backend: sin ?orden= sigue recientes", async () => {
    await request(buildApp()).get("/api/products");

    expect(orderByDeLaConsulta()).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });
});
