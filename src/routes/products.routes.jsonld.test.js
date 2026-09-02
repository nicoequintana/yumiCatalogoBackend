import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";
process.env.FRONTEND_URL = "https://yima.example.com";

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findUnique: (...args) => findUniqueMock(...args),
      update: (...args) => updateMock(...args),
      findMany: (...args) => findManyMock(...args),
    },
    eventoTrafico: { create: vi.fn().mockResolvedValue({}) },
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

const PRODUCTO = {
  id: 7,
  nombre: "Botella Térmica",
  descripcion: "Mantiene la temperatura por horas.",
  precio: "14250",
  stock: 5,
  visibleEnCatalogo: true,
  categoria: { id: 3, nombre: "Cocina" },
  categoriaId: 3,
  caracteristicas: [],
  fotos: [
    { id: 1, url: "https://res.cloudinary.com/demo/image/upload/v1/botella.jpg", orden: 0, cloudinaryPublicId: "botella" },
  ],
  listas: [],
  especificaciones: [],
  video: null,
};

beforeEach(() => {
  findUniqueMock.mockReset();
  updateMock.mockReset();
  findManyMock.mockReset();
  findManyMock.mockResolvedValue([]);
  findUniqueMock.mockResolvedValue(PRODUCTO);
  updateMock.mockResolvedValue(PRODUCTO);
});

/**
 * El JSON-LD de la ficha viaja EN la respuesta del detalle. Antes el frontend
 * lo armaba con su propia copia de `lib/jsonLd.js` (espejo manual entre repos):
 * el mismo producto podía declarar datos estructurados distintos según quién
 * ejecutara — la SPA o el HTML de crawler — sin que nada falle.
 */
describe("GET /products/:id — jsonLd en la respuesta", () => {
  it("emite los bloques Product y BreadcrumbList", async () => {
    const res = await request(buildApp()).get("/api/products/7");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.jsonLd)).toBe(true);

    const tipos = res.body.jsonLd.map((b) => b["@type"]);
    expect(tipos).toContain("Product");
    expect(tipos).toContain("BreadcrumbList");
  });

  it("el bloque Product lleva el precio como string y la URL canónica absoluta", async () => {
    const res = await request(buildApp()).get("/api/products/7");

    const bloque = res.body.jsonLd.find((b) => b["@type"] === "Product");
    expect(bloque.offers.price).toBe("14250");
    expect(bloque.offers.url).toBe("https://yima.example.com/producto/7-botella-termica");
  });

  it("las imágenes del bloque son URLs absolutas", async () => {
    const res = await request(buildApp()).get("/api/products/7");

    const bloque = res.body.jsonLd.find((b) => b["@type"] === "Product");
    for (const imagen of bloque.image) {
      expect(imagen).toMatch(/^https?:\/\//);
    }
  });
});
