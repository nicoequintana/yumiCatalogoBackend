import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const createMock = vi.fn();
const updateMock = vi.fn();
const findUniqueMock = vi.fn();
const findManyMock = vi.fn();
const findUniqueOrThrowMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      create: (...args) => createMock(...args),
      update: (...args) => updateMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      findMany: (...args) => findManyMock(...args),
      findUniqueOrThrow: (...args) => findUniqueOrThrowMock(...args),
    },
    $transaction: async (fn) =>
      fn({
        product: { update: (...args) => updateMock(...args), findUniqueOrThrow: (...args) => findUniqueOrThrowMock(...args) },
        caracteristica: { deleteMany: vi.fn(), createMany: vi.fn() },
        foto: { deleteMany: vi.fn(), update: vi.fn() },
        video: { update: vi.fn(), create: vi.fn(), delete: vi.fn() },
      }),
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

const productoBase = {
  id: 42,
  nombre: "Bruma Facial",
  sku: "YIMA-BRUMAF-1234",
  precio: "100",
  etiqueta: null,
  categoria: null,
  caracteristicas: [],
  fotos: [],
  video: null,
  vistas: 0,
  compartidos: 0,
  visibleEnCatalogo: true,
  disponibilidad: "DISPONIBLE",
  destacado: false,
  orden: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
  findUniqueMock.mockReset();
  findManyMock.mockReset();
  findUniqueOrThrowMock.mockReset();
});

describe("listar() ordena por orden asc, createdAt desc", () => {
  it("GET /api/products pasa el nuevo orderBy compuesto", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products");

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ orden: "asc" }, { createdAt: "desc" }] }),
    );
  });
});

describe("POST /api/products valida disponibilidad/destacado/orden", () => {
  function post(fields) {
    let req = request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .field("nombre", "Bruma Facial")
      .field("descripcion", "Descripción de prueba")
      .field("precio", "100");
    for (const [key, value] of Object.entries(fields)) {
      req = req.field(key, value);
    }
    return req;
  }

  it("crea con los defaults cuando no se envían los campos", async () => {
    createMock.mockResolvedValue({ ...productoBase });
    updateMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });

    const res = await post({});

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ disponibilidad: "DISPONIBLE", destacado: false, orden: 0 }),
      }),
    );
  });

  it("acepta disponibilidad, destacado y orden válidos", async () => {
    createMock.mockResolvedValue({ ...productoBase, disponibilidad: "AGOTADO", destacado: true, orden: 5 });
    updateMock.mockResolvedValue({ ...productoBase, disponibilidad: "AGOTADO", destacado: true, orden: 5 });

    const res = await post({ disponibilidad: "AGOTADO", destacado: "true", orden: "5" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ disponibilidad: "AGOTADO", destacado: true, orden: 5 }),
      }),
    );
  });

  it("rechaza disponibilidad fuera del set válido", async () => {
    const res = await post({ disponibilidad: "EN_OFERTA" });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rechaza destacado no booleano", async () => {
    const res = await post({ destacado: "sí" });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rechaza orden no numérico", async () => {
    const res = await post({ orden: "abc" });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rechaza orden con decimales", async () => {
    const res = await post({ orden: "1.5" });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("PUT /api/products/:id respeta esCreacion:false para merchandising", () => {
  it("no toca disponibilidad/destacado/orden si no se envían", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });
    updateMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });
    findUniqueOrThrowMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });

    const res = await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Bruma Facial")
      .field("descripcion", "Descripción de prueba")
      .field("precio", "100");

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ disponibilidad: undefined, destacado: undefined, orden: undefined }),
      }),
    );
  });

  it("rechaza disponibilidad inválida en edición", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });

    const res = await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Bruma Facial")
      .field("descripcion", "Descripción de prueba")
      .field("precio", "100")
      .field("disponibilidad", "INVALIDO");

    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/products/:id/merchandising", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp())
      .patch("/api/products/1/merchandising")
      .send({ destacado: true });

    expect(res.status).toBe(401);
  });

  it("actualiza destacado y devuelve el producto", async () => {
    findUniqueMock.mockResolvedValue({ id: 1 });
    updateMock.mockResolvedValue({ ...productoBase, id: 1, destacado: true });

    const res = await request(buildApp())
      .patch("/api/products/1/merchandising")
      .set("Authorization", authHeader)
      .send({ destacado: true });

    expect(res.status).toBe(200);
    expect(res.body.destacado).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, data: { destacado: true, orden: undefined } }),
    );
  });

  it("actualiza orden y devuelve el producto", async () => {
    findUniqueMock.mockResolvedValue({ id: 1 });
    updateMock.mockResolvedValue({ ...productoBase, id: 1, orden: 3 });

    const res = await request(buildApp())
      .patch("/api/products/1/merchandising")
      .set("Authorization", authHeader)
      .send({ orden: 3 });

    expect(res.status).toBe(200);
    expect(res.body.orden).toBe(3);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, data: { destacado: undefined, orden: 3 } }),
    );
  });

  it("acepta ambos campos juntos", async () => {
    findUniqueMock.mockResolvedValue({ id: 1 });
    updateMock.mockResolvedValue({ ...productoBase, id: 1, destacado: true, orden: 2 });

    const res = await request(buildApp())
      .patch("/api/products/1/merchandising")
      .set("Authorization", authHeader)
      .send({ destacado: true, orden: 2 });

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, data: { destacado: true, orden: 2 } }),
    );
  });

  it("responde 400 si no se envía ningún campo", async () => {
    const res = await request(buildApp())
      .patch("/api/products/1/merchandising")
      .set("Authorization", authHeader)
      .send({});

    expect(res.status).toBe(400);
  });

  it("responde 400 si destacado no es booleano", async () => {
    const res = await request(buildApp())
      .patch("/api/products/1/merchandising")
      .set("Authorization", authHeader)
      .send({ destacado: "sí" });

    expect(res.status).toBe(400);
  });

  it("responde 400 si orden no es un entero", async () => {
    const res = await request(buildApp())
      .patch("/api/products/1/merchandising")
      .set("Authorization", authHeader)
      .send({ orden: 1.5 });

    expect(res.status).toBe(400);
  });

  it("responde 404 si el producto no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp())
      .patch("/api/products/999/merchandising")
      .set("Authorization", authHeader)
      .send({ destacado: true });

    expect(res.status).toBe(404);
  });

  it("responde 404 si el id no es un número", async () => {
    const res = await request(buildApp())
      .patch("/api/products/abc/merchandising")
      .set("Authorization", authHeader)
      .send({ destacado: true });

    expect(res.status).toBe(404);
  });
});
