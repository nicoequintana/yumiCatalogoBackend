import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

/**
 * El limitador de lectura pública (600/5min) está MONTADO en `GET /categorias`.
 *
 * Mismo criterio y misma técnica que `products.ratelimit.test.js`: no se mockea
 * `rateLimit.middleware.js`, se verifica el cableado real por el header
 * `RateLimit-Limit`. El listado de categorías es público (alimenta los filtros
 * de `/coleccion` y la sección de categorías de la home) y pega a la base, así
 * que necesita el mismo techo que las lecturas públicas de producto.
 */

process.env.JWT_SECRET = "test-secret";

const categoriaFindManyMock = vi.fn();
const productGroupByMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    categoria: { findMany: (...args) => categoriaFindManyMock(...args) },
    product: { groupBy: (...args) => productGroupByMock(...args) },
  },
}));
vi.mock("../services/cloudinary.service.js", () => ({
  subirArchivo: vi.fn(),
  eliminarArchivo: vi.fn(),
}));

const { default: categoriasRouter } = await import("./categorias.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/categorias", categoriasRouter);
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  categoriaFindManyMock.mockResolvedValue([]);
  productGroupByMock.mockResolvedValue([]);
});

describe("rate limit del listado público de categorías (600/5min)", () => {
  it("expone RateLimit-Limit=600 en GET /categorias", async () => {
    const res = await request(buildApp()).get("/api/categorias");

    expect(res.headers["ratelimit-limit"]).toBe("600");
  });
});
