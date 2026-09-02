import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

// Buffer con firma JPEG real: la validación de magic bytes (`validarArchivos`)
// rechaza cualquier contenido que no corresponda al mimetype declarado.
const JPEG_VALIDO = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const updateMock = vi.fn();
const findUniqueMock = vi.fn();
const findUniqueOrThrowMock = vi.fn();
const fotoUpdateMock = vi.fn();
const fotoCreateManyMock = vi.fn();
const fotoDeleteManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      create: vi.fn(),
      update: (...args) => updateMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      findMany: vi.fn(),
      findUniqueOrThrow: (...args) => findUniqueOrThrowMock(...args),
    },
    $transaction: async (fn) =>
      fn({
        product: {
          update: (...args) => updateMock(...args),
          findUniqueOrThrow: (...args) => findUniqueOrThrowMock(...args),
        },
        caracteristica: { deleteMany: vi.fn(), createMany: vi.fn() },
        foto: {
          deleteMany: (...args) => fotoDeleteManyMock(...args),
          update: (...args) => fotoUpdateMock(...args),
          createMany: (...args) => fotoCreateManyMock(...args),
        },
        video: { update: vi.fn(), create: vi.fn(), delete: vi.fn() },
        productoLista: { deleteMany: vi.fn(), createMany: vi.fn() },
        especificacion: { deleteMany: vi.fn(), createMany: vi.fn() },
      }),
  },
}));
vi.mock("../services/cloudinary.service.js", () => ({
  subirArchivo: vi.fn(async (_buffer, _nombre, _carpeta) => ({
    url: "https://cdn.test/nueva.jpg",
    cloudinaryPublicId: `nueva-${Math.random()}`,
    cloudinaryResourceType: "image",
  })),
  // Deben devolver promesa: el controller les encadena `.catch(...)` al
  // limpiar los archivos de las fotos removidas.
  eliminarArchivo: vi.fn(async () => {}),
  eliminarCarpeta: vi.fn(async () => {}),
}));

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

/** Producto con tres fotos ya persistidas, en orden 0,1,2. */
const productoConFotos = {
  id: 42,
  nombre: "Lámpara",
  sku: "YIMA-LAMPARA-1",
  precio: "100",
  etiqueta: null,
  categoria: null,
  caracteristicas: [],
  video: null,
  vistas: 0,
  compartidos: 0,
  visibleEnCatalogo: true,
  stock: 10,
  destacado: false,
  orden: 0,
  listas: [],
  especificaciones: [],
  fotos: [
    { id: 10, orden: 0, url: "u10", cloudinaryPublicId: "c10", driveFileId: null },
    { id: 11, orden: 1, url: "u11", cloudinaryPublicId: "c11", driveFileId: null },
    { id: 12, orden: 2, url: "u12", cloudinaryPublicId: "c12", driveFileId: null },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueMock.mockResolvedValue(productoConFotos);
  findUniqueOrThrowMock.mockResolvedValue(productoConFotos);
  updateMock.mockResolvedValue(productoConFotos);
});

/** Devuelve los `orden` asignados a las fotos conservadas, por id. */
function ordenesAsignados() {
  return Object.fromEntries(
    fotoUpdateMock.mock.calls.map(([args]) => [args.where.id, args.data.orden]),
  );
}

describe("PUT /products/:id — orden explícito de fotos", () => {
  it("respeta el orden pedido para las fotos existentes", async () => {
    // El admin puso la foto 12 de portada y la 10 al final.
    await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Lámpara")
      .field("fotosExistentes", JSON.stringify([12, 11, 10]))
      .field(
        "ordenFotos",
        JSON.stringify([
          { tipo: "existente", id: 12 },
          { tipo: "existente", id: 11 },
          { tipo: "existente", id: 10 },
        ]),
      )
      .expect(200);

    expect(ordenesAsignados()).toEqual({ 12: 0, 11: 1, 10: 2 });
  });

  it("permite que una foto nueva quede de portada, delante de las existentes", async () => {
    await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Lámpara")
      .field("fotosExistentes", JSON.stringify([10, 11]))
      .field(
        "ordenFotos",
        JSON.stringify([
          { tipo: "nueva", index: 0 },
          { tipo: "existente", id: 10 },
          { tipo: "existente", id: 11 },
        ]),
      )
      .attach("fotos", JPEG_VALIDO, { filename: "portada.jpg", contentType: "image/jpeg" })
      .expect(200);

    // La nueva se lleva el orden 0; las existentes se corren a 1 y 2.
    expect(fotoCreateManyMock).toHaveBeenCalled();
    const creadas = fotoCreateManyMock.mock.calls[0][0].data;
    expect(creadas).toHaveLength(1);
    expect(creadas[0].orden).toBe(0);
    expect(ordenesAsignados()).toEqual({ 10: 1, 11: 2 });
  });

  it("sin `ordenFotos` mantiene el comportamiento anterior (existentes primero)", async () => {
    await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Lámpara")
      .field("fotosExistentes", JSON.stringify([10, 11]))
      .attach("fotos", JPEG_VALIDO, { filename: "extra.jpg", contentType: "image/jpeg" })
      .expect(200);

    expect(ordenesAsignados()).toEqual({ 10: 0, 11: 1 });
    expect(fotoCreateManyMock.mock.calls[0][0].data[0].orden).toBe(2);
  });

  it("rechaza un `ordenFotos` que no cubre exactamente las fotos enviadas", async () => {
    const res = await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Lámpara")
      .field("fotosExistentes", JSON.stringify([10, 11]))
      .field("ordenFotos", JSON.stringify([{ tipo: "existente", id: 10 }]))
      .expect(400);

    expect(res.body.error).toMatch(/ordenFotos/i);
  });

  it("rechaza un `ordenFotos` con una foto repetida", async () => {
    const res = await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Lámpara")
      .field("fotosExistentes", JSON.stringify([10, 11]))
      .field(
        "ordenFotos",
        JSON.stringify([
          { tipo: "existente", id: 10 },
          { tipo: "existente", id: 10 },
        ]),
      )
      .expect(400);

    expect(res.body.error).toMatch(/ordenFotos/i);
  });

  it("rechaza un `ordenFotos` que no es un JSON válido", async () => {
    const res = await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Lámpara")
      .field("fotosExistentes", JSON.stringify([10, 11]))
      .field("ordenFotos", "{esto no es json")
      .expect(400);

    expect(res.body.error).toMatch(/ordenFotos/i);
  });
});
