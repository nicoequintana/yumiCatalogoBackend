import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const createMock = vi.fn();
const updateMock = vi.fn();
const findUniqueMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      create: (...args) => createMock(...args),
      update: (...args) => updateMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      findMany: (...args) => findManyMock(...args),
    },
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

const token = jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
  findUniqueMock.mockReset();
  findManyMock.mockReset();
});

describe("crear() genera el sku", () => {
  it("arma el sku con las 6 letras del nombre y el id recién creado", async () => {
    createMock.mockResolvedValue({
      id: 42,
      nombre: "Bruma Facial",
      caracteristicas: [],
      fotos: [],
      video: null,
      categoria: null,
    });
    updateMock.mockResolvedValue({
      id: 42,
      nombre: "Bruma Facial",
      sku: "YIMA-BRUMAF-42",
      precio: "100",
      caracteristicas: [],
      fotos: [],
      video: null,
      categoria: null,
      vistas: 0,
      compartidos: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      visibleEnCatalogo: false,
    });

    const res = await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .field("nombre", "Bruma Facial")
      .field("descripcion", "Descripción de prueba")
      .field("precio", "100");

    expect(res.status).toBe(201);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sku: "YIMA-BRUMAF-42" }),
      }),
    );
  });
});
