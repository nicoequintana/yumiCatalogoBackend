import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const findUniqueMock = vi.fn();
const updateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findUnique: (...args) => findUniqueMock(...args),
      update: (...args) => updateMock(...args),
    },
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

const PRODUCTO_BASE = {
  id: 7,
  nombre: "Producto Agotado",
  precio: "3200",
  caracteristicas: [],
  fotos: [],
  listas: [],
  especificaciones: [],
};

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
});

/**
 * Decisión de producto: un producto sin stock SE VE pero NO SE PUEDE COMPRAR.
 * Su ficha de detalle sigue siendo pública (un link compartido no debe 404ear),
 * mientras que `visibleEnCatalogo: false` — el admin ocultándolo a propósito —
 * sí sigue devolviendo 404.
 */
describe("GET /products/:id — visibilidad según stock", () => {
  it("devuelve 200 para un producto agotado (stock 0) visible en catálogo", async () => {
    findUniqueMock.mockResolvedValue({ ...PRODUCTO_BASE, stock: 0, visibleEnCatalogo: true });
    updateMock.mockResolvedValue({ ...PRODUCTO_BASE, stock: 0, visibleEnCatalogo: true });

    const res = await request(buildApp()).get("/api/products/7");

    expect(res.status).toBe(200);
    expect(res.body.stock).toBe(0);
  });

  it("devuelve 404 si el producto está oculto del catálogo, aunque tenga stock", async () => {
    findUniqueMock.mockResolvedValue({ ...PRODUCTO_BASE, stock: 10, visibleEnCatalogo: false });

    const res = await request(buildApp()).get("/api/products/7");

    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("devuelve 404 si el producto no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/products/7");

    expect(res.status).toBe(404);
  });
});
