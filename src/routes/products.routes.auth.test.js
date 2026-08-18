import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

process.env.JWT_SECRET = "test-secret";

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));
vi.mock("../services/googleDrive.service.js", () => ({}));
vi.mock("../services/cloudinary.service.js", () => ({}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

describe("Auth en rutas de escritura de /api/products", () => {
  it("GET / sigue siendo pública", async () => {
    const res = await request(buildApp()).get("/api/products");
    expect(res.status).toBe(200);
  });

  it("POST / responde 401 sin token", async () => {
    const res = await request(buildApp()).post("/api/products").send({});
    expect(res.status).toBe(401);
  });

  it("PUT /:id responde 401 sin token", async () => {
    const res = await request(buildApp()).put("/api/products/1").send({});
    expect(res.status).toBe(401);
  });

  it("DELETE /:id responde 401 sin token", async () => {
    const res = await request(buildApp()).delete("/api/products/1");
    expect(res.status).toBe(401);
  });

  it("DELETE /:id/fotos/:fotoId responde 401 sin token", async () => {
    const res = await request(buildApp()).delete("/api/products/1/fotos/2");
    expect(res.status).toBe(401);
  });
});

describe("POST /:id/compartir es público", () => {
  it("responde sin exigir token (contador anónimo, igual que las vistas)", async () => {
    const { prisma } = await import("../lib/prisma.js");
    prisma.product.findUnique.mockResolvedValue({ id: 1 });
    prisma.product.update.mockResolvedValue({ id: 1, compartidos: 1 });

    const res = await request(buildApp()).post("/api/products/1/compartir");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
