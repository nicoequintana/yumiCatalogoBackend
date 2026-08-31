import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * El precio de venta NO se tipea: sale de `costo × coeficiente` (31/08/2026).
 *
 * Las dos puntas se comportan distinto, y la asimetría es deliberada:
 *
 *   - **`POST` escribe el precio derivado.** Un producto nuevo no tiene precio
 *     publicado que proteger, y la columna es `NOT NULL`: alguien tiene que
 *     poner el primer número, y el único correcto es el calculado.
 *   - **`PUT` NO escribe precio.** De eso depende que el flujo `Difiere` siga
 *     existiendo: cambiar un costo deja el producto marcado hasta que una
 *     persona lo aplique desde Costos y precios, con su tabla antes→después. Si
 *     la edición publicara sola, ese paso de revisión se evaporaría sin que
 *     nadie lo decidiera.
 *
 * Y en las dos, un `precio` que llegue en el body se IGNORA. No es un 400 a
 * propósito: el campo dejó de existir en el contrato, así que un cliente viejo
 * que todavía lo mande tiene que seguir funcionando — con el precio correcto,
 * no con el que mandó.
 */

const createMock = vi.fn();
const updateMock = vi.fn();
const findUniqueMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      create: (...args) => createMock(...args),
      update: (...args) => updateMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    usuario: { findUnique: vi.fn().mockResolvedValue({ id: 1, tokenVersion: 0 }) },
    $transaction: async (fn) =>
      fn({
        product: {
          update: (...args) => updateMock(...args),
          findUniqueOrThrow: (...args) => findUniqueMock(...args),
        },
        caracteristica: { deleteMany: vi.fn(), createMany: vi.fn() },
        productoLista: { deleteMany: vi.fn(), createMany: vi.fn() },
        especificacion: { deleteMany: vi.fn(), createMany: vi.fn() },
        foto: { deleteMany: vi.fn(), createMany: vi.fn(), update: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
        video: { deleteMany: vi.fn(), create: vi.fn() },
      }),
  },
}));
vi.mock("../services/googleDrive.service.js", () => ({
  eliminarArchivo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/cloudinary.service.js", () => ({
  eliminarCarpeta: vi.fn().mockResolvedValue(undefined),
}));
// Se parte del módulo real y se pisan solo las funciones que tocan la red.
// Enumerar los exports a mano hace que un archivo de test se rompa cuando el
// servicio suma una función, por un motivo que no tiene nada que ver con lo
// que el test afirma.
vi.mock("../services/productoMedia.service.js", async (importOriginal) => ({
  ...(await importOriginal()),
  subirArchivosNuevos: vi.fn().mockResolvedValue({ fotosSubidas: [], videoSubido: null }),
  subirMediaDeProducto: vi.fn().mockResolvedValue({ fotos: [], video: null }),
  limpiarArchivosSubidos: vi.fn().mockResolvedValue(undefined),
  limpiarMediaRemota: vi.fn().mockResolvedValue(undefined),
  logFallaDeLimpieza: vi.fn(),
}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

const authHeader = `Bearer ${jwt.sign({ sub: 1, tokenVersion: 0 }, "test-secret", { expiresIn: "7d" })}`;

/** Fila que devuelven `create`/`update`, con las relaciones que espera el mapper. */
function filaProducto(extra = {}) {
  return {
    id: 42,
    nombre: "Termo",
    sku: "YIMA-TERMO-1",
    descripcion: "Un termo",
    precio: "3075",
    costo: "1500",
    coeficiente: "2.05",
    etiqueta: null,
    categoria: null,
    stock: 0,
    destacado: false,
    visibleEnCatalogo: false,
    vistas: 0,
    compartidos: 0,
    favoritosCount: 0,
    fraseComercial: null,
    porQueLoVasAQuerer: null,
    tePasaEsto: null,
    caracteristicas: [],
    listas: [],
    especificaciones: [],
    fotos: [],
    video: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

/** El `data` con el que el controller llamó a `product.create`. */
function dataDelCreate() {
  return createMock.mock.calls[0][0].data;
}

/** El `data` del `product.update` que escribe los campos escalares. */
function dataDelUpdate() {
  return updateMock.mock.calls.find((llamada) => llamada[0]?.data?.nombre !== undefined)?.[0].data;
}

const BASE = { nombre: "Termo", descripcion: "Un termo" };

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
  findUniqueMock.mockReset();
  auditCreateMock.mockReset();
  createMock.mockResolvedValue(filaProducto());
  updateMock.mockResolvedValue(filaProducto());
  findUniqueMock.mockResolvedValue(filaProducto());
});

describe("POST /api/products — el precio se deriva del costo", () => {
  it("escribe el precio calculado, no el que vino en el body", async () => {
    const res = await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .send({ ...BASE, costo: "3075", coeficiente: "2.05", precio: "999999" });

    expect(res.status).toBe(201);
    // 3075 × 2,05 = 6303,75 → 6304 (redondeo al peso, medio peso hacia arriba).
    expect(dataDelCreate().precio).toBe("6304");
  });

  it("el coeficiente neutro deja el precio igual al costo", async () => {
    await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .send({ ...BASE, costo: "1000", coeficiente: "1" });

    expect(dataDelCreate().precio).toBe("1000");
  });

  it("guarda también el costo y el coeficiente que lo generaron", async () => {
    await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .send({ ...BASE, costo: "3075", coeficiente: "2.05" });

    const data = dataDelCreate();
    expect(data.costo).toBe("3075");
    expect(data.coeficiente).toBe("2.05");
  });

  it("rechaza un alta sin costo", async () => {
    const res = await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .send({ ...BASE, coeficiente: "2.05" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/costo/i);
    expect(createMock).not.toHaveBeenCalled();
  });

  /**
   * El costo y el coeficiente NO son simétricos, aunque los dos sean
   * obligatorios en la columna.
   *
   * El costo es un dato del negocio que nadie puede inventar: sin él, cualquier
   * precio que el sistema escriba es ficción. El coeficiente sí tiene un valor
   * neutro correcto —1, que deja el precio igual al costo— y aplicarlo acá y no
   * en cada cliente es lo que hace que el formulario, la planilla Excel y la
   * skill de alta desde MercadoLibre se comporten igual sin repetir la
   * constante en tres lugares.
   */
  it("un alta sin coeficiente usa el neutro, no falla", async () => {
    const res = await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .send({ ...BASE, costo: "3075" });

    expect(res.status).toBe(201);
    expect(dataDelCreate().coeficiente).toBe("1");
    expect(dataDelCreate().precio).toBe("3075");
  });

  it("un coeficiente vacío también cae al neutro", async () => {
    await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .send({ ...BASE, costo: "3075", coeficiente: "" });

    expect(dataDelCreate().coeficiente).toBe("1");
  });

  it("un precio suelto ya no alcanza para crear un producto", async () => {
    const res = await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .send({ ...BASE, precio: "5000" });

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("PUT /api/products/:id — editar NO publica precio", () => {
  it("no escribe la columna precio, ni siquiera si viene en el body", async () => {
    const res = await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .send({ ...BASE, costo: "4000", coeficiente: "2.05", precio: "8200" });

    expect(res.status).toBe(200);
    // Es lo que sostiene el flujo `Difiere`: el producto queda marcado hasta
    // que alguien aplique desde Costos y precios, con la previsualización de
    // por medio. Publicar acá evaporaría ese paso sin que nadie lo decidiera.
    expect(dataDelUpdate()).not.toHaveProperty("precio");
  });

  it("sí escribe el costo y el coeficiente nuevos", async () => {
    await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .send({ ...BASE, costo: "4000", coeficiente: "2.10" });

    const data = dataDelUpdate();
    expect(data.costo).toBe("4000");
    expect(data.coeficiente).toBe("2.1");
  });

  it("rechaza vaciar el costo de un producto ya cargado", async () => {
    const res = await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .send({ ...BASE, costo: "", coeficiente: "2.05" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/costo/i);
  });
});
