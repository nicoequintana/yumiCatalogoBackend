import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

/**
 * El limitador de lectura pública (600/5min) está MONTADO en
 * `GET /promociones/destacada`.
 *
 * Mismo criterio y misma técnica que `anuncios.ratelimit.test.js`: no se
 * mockea `rateLimit.middleware.js`, se verifica el cableado real por el
 * header `RateLimit-Limit`. La sección "Promos activas" de la home pública
 * se lee sin login en cada carga del catálogo — gap detectado en la
 * revisión de T5 (T4 la había dejado sin limitador).
 */

process.env.JWT_SECRET = "test-secret";

const promocionFindFirstMock = vi.fn();

vi.mock("../services/cloudinary.service.js", () => ({}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    promocion: { findFirst: (...args) => promocionFindFirstMock(...args) },
  },
}));

const { default: promocionesRouter } = await import("./promociones.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/promociones", promocionesRouter);
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  promocionFindFirstMock.mockResolvedValue(null);
});

describe("rate limit de la lectura pública de /promociones/destacada (600/5min)", () => {
  it("expone RateLimit-Limit=600 en GET /promociones/destacada", async () => {
    const res = await request(buildApp()).get("/api/promociones/destacada");

    expect(res.headers["ratelimit-limit"]).toBe("600");
  });
});
