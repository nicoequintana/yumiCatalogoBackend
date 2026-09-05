/**
 * `GET /api/products?conDescuento=1` — el riel de "Ofertas de la semana" de la
 * home.
 *
 * La condición de vigencia NO se escribe acá ni en el controller: sale de
 * `condicionProductoConDescuento` (`lib/precioEfectivo.js`), la misma que
 * resuelve el precio efectivo. Estos tests solo afirman que el controller la
 * conecta al `where` y que compone con el resto de los filtros, nunca que la
 * reimplementa.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

const findManyMock = vi.fn();
const countMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    // Sin promociones vigentes, que es el caso normal. `resolverDescuentos`
    // igual consulta cuando hay productos, así que el mock tiene que existir.
    promocionItem: { findMany: async () => [] },
    product: {
      findMany: (...args) => findManyMock(...args),
      count: (...args) => countMock(...args),
    },
  },
}));
vi.mock("../services/cloudinary.service.js", () => ({}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  // El error handler REAL, no uno improvisado: un test que afirme un cuerpo de
  // error contra un handler de mentira puede pasar mientras producción manda otra cosa.
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  findManyMock.mockReset();
  countMock.mockReset().mockResolvedValue(0);
});

describe("GET /products?conDescuento=1", () => {
  it("filtra por la relación de items de promoción", async () => {
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/products?conDescuento=1");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.itemsPromocion.some.habilitado).toBe(true);
    expect(where.itemsPromocion.some.promocion.activa).toBe(true);
  });

  it("COMPONE con las guardas públicas, no las reemplaza", async () => {
    // Un producto rebajado pero oculto o agotado no puede aparecer por estar
    // en oferta: la campaña elige qué exhibir, no cambia qué se puede publicar.
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/products?conDescuento=1");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.visibleEnCatalogo).toBe(true);
    expect(where.stock).toEqual({ gt: 0 });
  });

  it("NO usa una lista de ids", async () => {
    // `id: { in: [...] }` revienta el límite de 2.100 parámetros de SQL Server
    // en cuanto haya muchos rebajados, y sale como un 500 opaco.
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/products?conDescuento=1");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.id).toBeUndefined();
  });

  it("sin el parámetro, el where NO lleva el filtro", async () => {
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/products");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where?.itemsPromocion).toBeUndefined();
  });

  it("compone con categoria", async () => {
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/products?conDescuento=1&categoria=1002");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.categoriaId).toBe(1002);
    expect(where.itemsPromocion).toBeDefined();
  });
});
