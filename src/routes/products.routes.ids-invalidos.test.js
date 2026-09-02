import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * Un `:id` que no es un entero (`1.5`, `abc`) tiene que ser el MISMO 404 que
 * un id inexistente, resuelto ANTES de tocar la base.
 *
 * El patrón viejo (`Number.isNaN(id)`) dejaba pasar los floats: `Number("1.5")`
 * es `1.5`, no NaN, así que llegaba a Prisma como filtro sobre una columna
 * `Int` y explotaba con `PrismaClientValidationError` → 500 + fila en
 * `ErrorLog`, en endpoints públicos donde cualquier URL manoseada lo dispara.
 * Acá los mocks de Prisma no replican esa validación, por eso lo que se fija
 * es que la base NO se consulte con un id no entero.
 */

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
const findManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findUnique: (...args) => findUniqueMock(...args),
      update: (...args) => updateMock(...args),
      findMany: (...args) => findManyMock(...args),
      count: vi.fn().mockResolvedValue(0),
    },
    eventoTrafico: { create: vi.fn().mockResolvedValue({ id: 1 }) },
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ids no enteros — 404 sin consultar la base", () => {
  it("GET /api/products/1.5 responde 404, no 500, y no consulta Prisma", async () => {
    const res = await request(buildApp()).get("/api/products/1.5");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Producto no encontrado." });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("GET /api/products/abc responde 404 sin consultar Prisma", async () => {
    const res = await request(buildApp()).get("/api/products/abc");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Producto no encontrado." });
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("POST /api/products/1.5/compartir responde 404 sin tocar la base", async () => {
    const res = await request(buildApp()).post("/api/products/1.5/compartir");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Producto no encontrado." });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("POST /api/products/1.5/favorito responde 404 sin tocar la base", async () => {
    const res = await request(buildApp()).post("/api/products/1.5/favorito");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Producto no encontrado." });
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
});
