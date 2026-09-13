/**
 * `GET /api/products/mas-vendidos` — el riel de "Más vendidos" de la home
 * (T14 lo consume y solo lo renderiza con >= `MIN_MAS_VENDIDOS` productos,
 * umbral que decide el FRONTEND, no este endpoint).
 *
 * La condición de "venta" es `ESTADOS_FACTURABLES`
 * (`admin.controller.js`) sobre `ItemOrden` de los últimos 90 días — se
 * reutiliza el patrón de agregación de `promociones.controller.js`'s
 * `listadoComercial`, no se reinventa una segunda forma de "ventas por
 * producto".
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

const groupByItemOrdenMock = vi.fn();
const findManyProductMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    itemOrden: { groupBy: (...args) => groupByItemOrdenMock(...args) },
    product: { findMany: (...args) => findManyProductMock(...args) },
    // `resolverDescuentos` consulta esto siempre que haya productos, mismo
    // gotcha documentado en `products.routes.conDescuento.test.js`.
    promocionItem: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));
vi.mock("../services/cloudinary.service.js", () => ({}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

function productoDeListado(overrides = {}) {
  return {
    id: 1,
    sku: "SKU-1",
    nombre: "Producto",
    precio: "1000",
    costo: null,
    coeficiente: null,
    etiqueta: null,
    visibleEnCatalogo: true,
    stock: 5,
    destacado: false,
    vistas: 0,
    compartidos: 0,
    categoria: null,
    fotos: [],
    _count: { fotos: 0 },
    createdAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  groupByItemOrdenMock.mockReset();
  findManyProductMock.mockReset();
});

describe("GET /api/products/mas-vendidos", () => {
  it("filtra por ESTADOS_FACTURABLES y los últimos 90 días", async () => {
    groupByItemOrdenMock.mockResolvedValue([]);
    findManyProductMock.mockResolvedValue([]);
    await request(buildApp()).get("/api/products/mas-vendidos");

    const args = groupByItemOrdenMock.mock.calls[0][0];
    expect(args.where.orden.estado).toEqual({ in: ["EN_PREPARACION", "ENTREGADA"] });
    expect(args.where.orden.createdAt.gte).toBeInstanceOf(Date);
  });

  it("solo incluye productos publicados con stock, aunque hayan vendido", async () => {
    groupByItemOrdenMock.mockResolvedValue([{ productId: 5, _sum: { cantidad: 40 } }]);
    findManyProductMock.mockResolvedValue([]);
    await request(buildApp()).get("/api/products/mas-vendidos");

    const args = findManyProductMock.mock.calls[0][0];
    expect(args.where.visibleEnCatalogo).toBe(true);
    expect(args.where.stock).toEqual({ gt: 0 });
  });

  it("rankea por unidades vendidas descendente", async () => {
    groupByItemOrdenMock.mockResolvedValue([
      { productId: 1, _sum: { cantidad: 5 } },
      { productId: 2, _sum: { cantidad: 40 } },
    ]);
    findManyProductMock.mockResolvedValue([
      productoDeListado({ id: 1 }),
      productoDeListado({ id: 2 }),
    ]);
    const res = await request(buildApp()).get("/api/products/mas-vendidos");
    expect(res.status).toBe(200);
    expect(res.body.data.map((p) => p.id)).toEqual([2, 1]);
  });

  it("devuelve un array vacío sin explotar cuando no hubo ventas", async () => {
    groupByItemOrdenMock.mockResolvedValue([]);
    findManyProductMock.mockResolvedValue([]);
    const res = await request(buildApp()).get("/api/products/mas-vendidos");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("cada producto sale con la misma forma que el listado (esNuevo incluido)", async () => {
    groupByItemOrdenMock.mockResolvedValue([{ productId: 1, _sum: { cantidad: 5 } }]);
    findManyProductMock.mockResolvedValue([productoDeListado({ id: 1 })]);
    const res = await request(buildApp()).get("/api/products/mas-vendidos");
    expect(res.body.data[0]).toHaveProperty("esNuevo");
    expect(res.body.data[0]).toHaveProperty("precioEfectivo");
  });

  it("respeta ?pageSize dentro del tope MAX_IDS_LISTADO", async () => {
    groupByItemOrdenMock.mockResolvedValue([]);
    findManyProductMock.mockResolvedValue([]);
    await request(buildApp()).get("/api/products/mas-vendidos?pageSize=500");

    const args = groupByItemOrdenMock.mock.calls[0][0];
    expect(args.take).toBe(100);
  });
});
