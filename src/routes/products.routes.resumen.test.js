import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * `GET /api/products/resumen` — los contadores de catálogo del listado del admin.
 *
 * Lo que esta suite fija, más allá del camino feliz:
 *
 *   1. **La ruta no puede ser tragada por `/:id`.** Va declarada antes; si
 *      alguien la mueve, Express matchea "resumen" como un id y el listado
 *      responde en su lugar (404, porque no es un entero).
 *   2. **Exige auth.** Los conteos incluyen productos ocultos, que es
 *      exactamente lo que la vista pública no puede ver.
 *   3. **`visibles` y `publicados` NO son el mismo número.** Un producto
 *      visible pero agotado no aparece en `/coleccion`, y el listado del admin
 *      necesita poder explicar esa diferencia en vez de mostrar un número que
 *      no coincide con la tienda.
 */

const countMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      count: (...args) => countMock(...args),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    usuario: { findUnique: vi.fn().mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true }) },
    eventoTrafico: { create: vi.fn().mockResolvedValue({ id: 1 }) },
  },
}));

vi.mock("../services/cloudinary.service.js", () => ({
  eliminarCarpeta: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/productoMedia.service.js", () => ({
  limpiarArchivosSubidos: vi.fn().mockResolvedValue(undefined),
  limpiarMediaRemota: vi.fn().mockResolvedValue(undefined),
  logFallaDeLimpieza: vi.fn(),
  sanitizarNombreParaCarpeta: (nombre) => nombre,
  subirArchivosNuevos: vi.fn().mockResolvedValue({ fotosSubidas: [], videoSubido: null }),
}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

function conAuth(peticion) {
  const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
    expiresIn: "7d",
  });
  return peticion.set("Authorization", `Bearer ${token}`);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/products/resumen", () => {
  it("devuelve los cinco conteos del catálogo", async () => {
    // Un `count` por métrica, en el orden en que el controller los pide.
    countMock
      .mockResolvedValueOnce(63) // total
      .mockResolvedValueOnce(58) // visibles
      .mockResolvedValueOnce(55) // publicados
      .mockResolvedValueOnce(6) // destacados
      .mockResolvedValueOnce(5); // destacadosPublicados

    const res = await conAuth(request(buildApp()).get("/api/products/resumen"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      total: 63,
      visibles: 58,
      publicados: 55,
      destacados: 6,
      destacadosPublicados: 5,
    });
  });

  it("cuenta `publicados` con stock, no solo con visibilidad", async () => {
    countMock.mockResolvedValue(0);

    await conAuth(request(buildApp()).get("/api/products/resumen"));

    expect(countMock).toHaveBeenCalledWith({ where: { visibleEnCatalogo: true, stock: { gt: 0 } } });
    expect(countMock).toHaveBeenCalledWith({
      where: { destacado: true, visibleEnCatalogo: true, stock: { gt: 0 } },
    });
  });

  it("responde 401 sin token: los conteos incluyen productos ocultos", async () => {
    countMock.mockResolvedValue(0);

    const res = await request(buildApp()).get("/api/products/resumen");

    expect(res.status).toBe(401);
    expect(countMock).not.toHaveBeenCalled();
  });

  it("no la matchea `GET /:id`", async () => {
    countMock.mockResolvedValue(0);

    const res = await conAuth(request(buildApp()).get("/api/products/resumen"));

    // Si `/:id` la tragara, `Number("resumen")` sería NaN y el detalle
    // respondería 404 en vez de los conteos.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("total");
  });
});
