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
const findUniqueOrThrowMock = vi.fn();
const listaDeleteManyMock = vi.fn();
const listaCreateManyMock = vi.fn();
const especificacionDeleteManyMock = vi.fn();
const especificacionCreateManyMock = vi.fn();

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
        productoLista: {
          deleteMany: (...args) => listaDeleteManyMock(...args),
          createMany: (...args) => listaCreateManyMock(...args),
        },
        especificacion: {
          deleteMany: (...args) => especificacionDeleteManyMock(...args),
          createMany: (...args) => especificacionCreateManyMock(...args),
        },
      }),
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
  stock: 10,
  destacado: false,
  orden: 0,
  fraseComercial: null,
  porQueLoVasAQuerer: null,
  tePasaEsto: null,
  listas: [],
  especificaciones: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
  findUniqueMock.mockReset();
  findManyMock.mockReset();
  findUniqueOrThrowMock.mockReset();
  listaDeleteManyMock.mockReset();
  listaCreateManyMock.mockReset();
  especificacionDeleteManyMock.mockReset();
  especificacionCreateManyMock.mockReset();
});

function post(fields) {
  let req = request(buildApp())
    .post("/api/products")
    .set("Authorization", authHeader)
    .field("nombre", "Bruma Facial")
    .field("descripcion", "Descripción de prueba")
    .field("precio", "100")
      .field("costo", "100");
  for (const [key, value] of Object.entries(fields)) {
    req = req.field(key, value);
  }
  return req;
}

describe("POST /api/products — guarda de categoriaId", () => {
  it("un categoriaId no numérico responde 400, no 500, y no toca la base", async () => {
    const res = await post({ categoriaId: "abc" });

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/products agrupa listas por tipo y expone especificaciones", () => {
  it("devuelve fraseComercial, beneficios, usos y especificaciones en la respuesta", async () => {
    const productoCreado = {
      ...productoBase,
      fraseComercial: "La frase comercial",
      porQueLoVasAQuerer: "Por que lo vas a querer",
      tePasaEsto: "Te pasa esto",
      listas: [
        { id: 1, tipo: "BENEFICIO", texto: "Hidrata la piel", orden: 0 },
        { id: 2, tipo: "USO", texto: "Aplicar de mañana", orden: 0 },
      ],
      especificaciones: [{ id: 1, nombre: "Material", valor: "ABS", orden: 0 }],
    };
    createMock.mockResolvedValue({ ...productoCreado, fotos: [], video: null });
    updateMock.mockResolvedValue({ ...productoCreado, fotos: [], video: null });

    const res = await post({
      fraseComercial: "La frase comercial",
      porQueLoVasAQuerer: "Por que lo vas a querer",
      tePasaEsto: "Te pasa esto",
      beneficios: JSON.stringify([{ texto: "Hidrata la piel" }]),
      usos: JSON.stringify([{ texto: "Aplicar de mañana" }]),
      especificaciones: JSON.stringify([{ nombre: "Material", valor: "ABS" }]),
    });

    expect(res.status).toBe(201);
    expect(res.body.fraseComercial).toBe("La frase comercial");
    expect(res.body.porQueLoVasAQuerer).toBe("Por que lo vas a querer");
    expect(res.body.tePasaEsto).toBe("Te pasa esto");
    expect(res.body.beneficios).toEqual([{ id: 1, texto: "Hidrata la piel" }]);
    expect(res.body.usos).toEqual([{ id: 2, texto: "Aplicar de mañana" }]);
    expect(res.body.idealPara).toEqual([]);
    expect(res.body.incluye).toEqual([]);
    expect(res.body.especificaciones).toEqual([{ id: 1, nombre: "Material", valor: "ABS" }]);
  });

  it("crea el producto sin ningún campo comercial (todos opcionales)", async () => {
    createMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });
    updateMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });

    const res = await post({});

    expect(res.status).toBe(201);
    expect(res.body.fraseComercial).toBe(null);
    expect(res.body.beneficios).toEqual([]);
    expect(res.body.especificaciones).toEqual([]);
  });

  it("asigna orden por posición dentro de cada tipo de lista, no globalmente entre tipos", async () => {
    createMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });
    updateMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });

    await post({
      beneficios: JSON.stringify([{ texto: "Beneficio 1" }, { texto: "Beneficio 2" }]),
      usos: JSON.stringify([{ texto: "Uso 1" }]),
      especificaciones: JSON.stringify([
        { nombre: "Material", valor: "ABS" },
        { nombre: "Peso", valor: "250 g" },
      ]),
    });

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          listas: {
            create: [
              { texto: "Beneficio 1", tipo: "BENEFICIO", orden: 0 },
              { texto: "Beneficio 2", tipo: "BENEFICIO", orden: 1 },
              { texto: "Uso 1", tipo: "USO", orden: 0 },
            ],
          },
          especificaciones: {
            create: [
              { nombre: "Material", valor: "ABS", orden: 0 },
              { nombre: "Peso", valor: "250 g", orden: 1 },
            ],
          },
        }),
      }),
    );
  });
});

describe("PUT /api/products/:id reemplaza listas y especificaciones (full replace)", () => {
  it("reemplaza los beneficios con deleteMany + createMany filtrados por tipo", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });
    findUniqueOrThrowMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });
    updateMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });

    const res = await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Bruma Facial")
      .field("descripcion", "Descripción de prueba")
      .field("precio", "100")
      .field("costo", "100")
      .field("beneficios", JSON.stringify([{ texto: "Nuevo beneficio" }]));

    expect(res.status).toBe(200);
    expect(listaDeleteManyMock).toHaveBeenCalledWith({ where: { productId: 42, tipo: "BENEFICIO" } });
    expect(listaCreateManyMock).toHaveBeenCalledWith({
      data: [{ texto: "Nuevo beneficio", tipo: "BENEFICIO", orden: 0, productId: 42 }],
    });
  });
});
