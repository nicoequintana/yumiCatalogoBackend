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
  it("arma el sku con las 6 letras del nombre antes de crear el producto (sku es NOT NULL)", async () => {
    createMock.mockResolvedValue({
      id: 42,
      nombre: "Bruma Facial",
      sku: "YIMA-BRUMAF-1234",
      precio: "100",
      caracteristicas: [],
      fotos: [],
      video: null,
      categoria: null,
    });
    updateMock.mockResolvedValue({
      id: 42,
      nombre: "Bruma Facial",
      sku: "YIMA-BRUMAF-1234",
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
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sku: expect.stringMatching(/^YIMA-BRUMAF-\d{4}$/) }),
      }),
    );
  });

  it("reintenta con un nuevo sku si choca con uno existente (P2002)", async () => {
    const errorColision = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["sku"] },
    });

    createMock.mockRejectedValueOnce(errorColision).mockResolvedValueOnce({
      id: 42,
      nombre: "Bruma Facial",
      sku: "YIMA-BRUMAF-5678",
      precio: "100",
      caracteristicas: [],
      fotos: [],
      video: null,
      categoria: null,
    });
    updateMock.mockResolvedValue({
      id: 42,
      nombre: "Bruma Facial",
      sku: "YIMA-BRUMAF-5678",
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
    expect(createMock).toHaveBeenCalledTimes(2);
  });
});

describe("listar() filtra por visibilidad", () => {
  it("GET /api/products sin ?admin solo trae productos visibles", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products");

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { visibleEnCatalogo: true } }),
    );
  });

  it("GET /api/products?admin=1 trae todos los productos, visibles y ocultos", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?admin=1");

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });
});

describe("PATCH /api/products/:id/visibilidad", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp())
      .patch("/api/products/1/visibilidad")
      .send({ visibleEnCatalogo: true });

    expect(res.status).toBe(401);
  });

  it("actualiza visibleEnCatalogo y devuelve el producto", async () => {
    findUniqueMock.mockResolvedValue({ id: 1, nombre: "Producto X" });
    updateMock.mockResolvedValue({
      id: 1,
      nombre: "Producto X",
      sku: "YIMA-PRODUC-1",
      precio: "50",
      etiqueta: null,
      categoria: null,
      caracteristicas: [],
      fotos: [],
      video: null,
      vistas: 0,
      compartidos: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      visibleEnCatalogo: true,
    });

    const res = await request(buildApp())
      .patch("/api/products/1/visibilidad")
      .set("Authorization", authHeader)
      .send({ visibleEnCatalogo: true });

    expect(res.status).toBe(200);
    expect(res.body.visibleEnCatalogo).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, data: { visibleEnCatalogo: true } }),
    );
  });

  it("responde 404 si el producto no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp())
      .patch("/api/products/999/visibilidad")
      .set("Authorization", authHeader)
      .send({ visibleEnCatalogo: true });

    expect(res.status).toBe(404);
  });

  it("responde 400 si visibleEnCatalogo no es un booleano", async () => {
    const res = await request(buildApp())
      .patch("/api/products/1/visibilidad")
      .set("Authorization", authHeader)
      .send({ visibleEnCatalogo: "sí" });

    expect(res.status).toBe(400);
  });

  it("responde 404 si el id no es un número", async () => {
    const res = await request(buildApp())
      .patch("/api/products/abc/visibilidad")
      .set("Authorization", authHeader)
      .send({ visibleEnCatalogo: true });

    expect(res.status).toBe(404);
  });
});
