import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

/**
 * El limitador de lectura pública (600/5min) está MONTADO en `GET /anuncios`.
 *
 * Mismo criterio y misma técnica que `products.ratelimit.test.js`: no se mockea
 * `rateLimit.middleware.js`, se verifica el cableado real por el header
 * `RateLimit-Limit`. La cinta de anuncios se lee sin login en cada carga del
 * catálogo público y pega a la base, así que necesita el mismo techo que las
 * demás lecturas públicas.
 */

process.env.JWT_SECRET = "test-secret";

const anuncioFindManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    anuncio: { findMany: (...args) => anuncioFindManyMock(...args) },
  },
}));

const { default: anunciosRouter } = await import("./anuncios.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/anuncios", anunciosRouter);
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  anuncioFindManyMock.mockResolvedValue([]);
});

describe("rate limit del listado público de anuncios (600/5min)", () => {
  it("expone RateLimit-Limit=600 en GET /anuncios", async () => {
    const res = await request(buildApp()).get("/api/anuncios");

    expect(res.headers["ratelimit-limit"]).toBe("600");
  });
});
