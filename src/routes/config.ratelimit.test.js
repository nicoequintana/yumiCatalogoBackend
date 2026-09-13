import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

/**
 * El limitador de lectura pública (600/5min) está MONTADO en `GET /config/home`.
 *
 * Mismo criterio y misma técnica que `anuncios.ratelimit.test.js`: no se
 * mockea `rateLimit.middleware.js`, se verifica el cableado real por el
 * header `RateLimit-Limit`. La sección "Producto ícono" de la home se lee
 * sin login en cada carga del catálogo público y son 3 consultas por
 * request (`ConfiguracionHome`, `Product`, `PromocionItem` de
 * `resolverDescuentos`), así que necesita el mismo techo que las demás
 * lecturas públicas — gap detectado en la revisión de T5.
 */

process.env.JWT_SECRET = "test-secret";

const configuracionHomeFindUniqueMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    configuracionHome: { findUnique: (...args) => configuracionHomeFindUniqueMock(...args) },
  },
}));

const { default: configRouter } = await import("./config.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/config", configRouter);
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  configuracionHomeFindUniqueMock.mockResolvedValue(null);
});

describe("rate limit de la lectura pública de /config/home (600/5min)", () => {
  it("expone RateLimit-Limit=600 en GET /config/home", async () => {
    const res = await request(buildApp()).get("/api/config/home");

    expect(res.headers["ratelimit-limit"]).toBe("600");
  });
});
