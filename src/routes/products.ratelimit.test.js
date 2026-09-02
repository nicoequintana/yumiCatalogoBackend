import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

/**
 * El limitador de las lecturas públicas de producto (600/5min) y el de la
 * generación de imágenes (20/60min) están MONTADOS en el router.
 *
 * Este archivo NO mockea `rateLimit.middleware.js` a propósito: verifica el
 * cableado real observando el header `RateLimit-Limit`, que `standardHeaders`
 * agrega en toda respuesta, no solo en el 429. El comportamiento del 429 en sí
 * ya está cubierto en `middlewares/rateLimit.middleware.test.js`; acá solo se
 * comprueba qué limitador envuelve cada ruta y con qué techo.
 *
 * Se afirma sobre el header —no sobre un 429— porque disparar cientos de
 * requests sería lento y frágil, mientras que el header viaja en una sola
 * request normal. Como el limitador es el PRIMER middleware de cada ruta, el
 * header sale igual aunque la respuesta sea un 404 (id inexistente) o un 401
 * (sin token).
 */

process.env.JWT_SECRET = "test-secret";

const productFindManyMock = vi.fn();
const productCountMock = vi.fn();
const productFindUniqueMock = vi.fn();
const fotoFindFirstMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findMany: (...args) => productFindManyMock(...args),
      count: (...args) => productCountMock(...args),
      findUnique: (...args) => productFindUniqueMock(...args),
    },
    foto: { findFirst: (...args) => fotoFindFirstMock(...args) },
  },
}));
vi.mock("../services/cloudinary.service.js", () => ({}));
vi.mock("../services/n8n.service.js", () => ({
  enviarPedidoDeImagenes: vi.fn(),
  estaConfigurado: vi.fn(() => true),
  MAX_REFERENCIAS: 4,
}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Respuestas mínimas para que cada lectura pública responda limpio: el
  // listado, vacío; el detalle y los dos proxies de media, un 404 (id
  // inexistente).
  productFindManyMock.mockResolvedValue([]);
  productCountMock.mockResolvedValue(0);
  productFindUniqueMock.mockResolvedValue(null);
  fotoFindFirstMock.mockResolvedValue(null);
});

describe("rate limit de las lecturas públicas de producto (600/5min)", () => {
  it("expone RateLimit-Limit=600 en GET /products", async () => {
    const res = await request(buildApp()).get("/api/products");

    expect(res.headers["ratelimit-limit"]).toBe("600");
  });

  it("expone RateLimit-Limit=600 en GET /products/:id", async () => {
    const res = await request(buildApp()).get("/api/products/999");

    expect(res.headers["ratelimit-limit"]).toBe("600");
  });


});

describe("rate limit de la generación de imágenes (20/60min)", () => {
  // El costo real de generar es externo y monetario (n8n/gpt-image-1), así que
  // el limitador va aunque la ruta ya exija auth. Se declara ANTES de
  // `requireAuth`, por eso el header viaja incluso en el 401 sin token.
  it("expone RateLimit-Limit=20 en POST /products/:id/generar-imagenes", async () => {
    const res = await request(buildApp()).post("/api/products/7/generar-imagenes");

    expect(res.headers["ratelimit-limit"]).toBe("20");
  });
});
