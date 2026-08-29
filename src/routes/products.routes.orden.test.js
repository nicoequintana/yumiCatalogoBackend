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
});
