import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const createMock = vi.fn();
const updateMock = vi.fn();
const findUniqueMock = vi.fn();
const findManyMock = vi.fn();
const countMock = vi.fn().mockResolvedValue(0);

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      create: (...args) => createMock(...args),
      update: (...args) => updateMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      findMany: (...args) => findManyMock(...args),
      count: (...args) => countMock(...args),
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

const token = jwt.sign({ sub: 1, tokenVersion: 0 }, "test-secret", { expiresIn: "7d" });
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
      .field("precio", "100")
      .field("costo", "100");

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sku: expect.stringMatching(/^YIMA-BRUMAF-\d{4}$/) }),
      }),
    );
  });

  /**
   * La forma que mandan los conectores que SÍ pueblan `meta.target`.
   */
  const P2002_CON_TARGET = () =>
    Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["sku"] },
    });

  /**
   * La forma REAL bajo `@prisma/adapter-mssql` —el conector de este proyecto—,
   * medida contra la base el 2026-09-11: `meta = { modelName,
   * driverAdapterError }` y NINGÚN `target`. Preguntar por `target` daba
   * `false` para CUALQUIER colisión, así que el reintento del sku nunca
   * corría: un choque del sufijo aleatorio devolvía un 400 al admin.
   */
  const P2002_SIN_TARGET = () =>
    Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { modelName: "Product", driverAdapterError: {} },
    });

  it.each([
    ["con meta.target (conectores que lo pueblan)", P2002_CON_TARGET],
    ["SIN meta.target (forma real de @prisma/adapter-mssql)", P2002_SIN_TARGET],
  ])("reintenta con un nuevo sku si choca con uno existente (P2002 %s)", async (_titulo, armarError) => {
    const errorColision = armarError();
    // La señal NO es la forma del error: es el re-lookup por la clave natural.
    // Si el sku que se intentó escribir ya está tomado, esa ES la colisión.
    findUniqueMock.mockResolvedValue({ id: 7, sku: "YIMA-BRUMAF-1234" });

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
      .field("precio", "100")
      .field("costo", "100");

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledTimes(2);
    // El re-lookup va por el sku que se intentó escribir, no por la forma del error.
    expect(findUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sku: expect.stringMatching(/^YIMA-BRUMAF-\d{4}$/) } }),
    );
  });

  it("un P2002 cuyo re-lookup por sku no encuentra nada se relanza tal cual: no se reintenta a ciegas", async () => {
    // Otro unique del insert (no el del sku). Sin `target` no se puede saber
    // cuál fue por la forma del error, así que decide el re-lookup: si el sku
    // que se intentó escribir está libre, la colisión es otra y el error
    // original sale sin tocar, en vez de gastar cinco intentos idénticos.
    const errorColision = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { modelName: "Product", driverAdapterError: {} },
    });

    findUniqueMock.mockResolvedValue(null);
    createMock.mockRejectedValue(errorColision);

    const res = await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .field("nombre", "Bruma Facial")
      .field("descripcion", "Descripción de prueba")
      .field("precio", "100")
      .field("costo", "100");

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);
  });
});

describe("listar() filtra por visibilidad", () => {
  it("GET /api/products sin ?admin solo trae productos visibles", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products");

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { visibleEnCatalogo: true, stock: { gt: 0 } } }),
    );
  });

  it("GET /api/products autenticado trae todos los productos, visibles y ocultos", async () => {
    // Antes este test pasaba con solo `?admin=1` y SIN token — encodeaba el
    // agujero: cualquiera podía listar los productos ocultos agregando un
    // parámetro a la URL. Ahora la vista admin la habilita el JWT verificado.
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?admin=1").set("Authorization", authHeader);

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  it("GET /api/products?admin=1 SIN token sigue filtrando por visibilidad y stock", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?admin=1");

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { visibleEnCatalogo: true, stock: { gt: 0 } } }),
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
