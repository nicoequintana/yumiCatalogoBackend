import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const productMock = { findUnique: vi.fn(), delete: vi.fn(), update: vi.fn(), findMany: vi.fn() };
const comboItemMock = { findMany: vi.fn() };
const usuarioFindUniqueMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findUnique: (...a) => productMock.findUnique(...a),
      delete: (...a) => productMock.delete(...a),
      // `GET /products/:id` (Task 12): vista pública suma `vistas` con
      // `update`, y `obtenerRelacionados` consulta `findMany` si hay categoría.
      update: (...a) => productMock.update(...a),
      findMany: (...a) => productMock.findMany(...a),
    },
    comboItem: { findMany: (...a) => comboItemMock.findMany(...a) },
    // Sin promociones vigentes: `resolverDescuentos` de la ficha.
    promocionItem: { findMany: async () => [] },
    eventoTrafico: { create: vi.fn().mockResolvedValue({}) },
    usuario: { findUnique: (...a) => usuarioFindUniqueMock(...a) },
    auditLog: { create: (...a) => auditCreateMock(...a) },
  },
}));
// `borrarFilaYLimpiarMedia` barre la carpeta del producto en Cloudinary: sin
// este mock el test saldría a la red. Mismo mock que `products.routes.eliminar.test.js`.
vi.mock("../services/cloudinary.service.js", () => ({
  eliminarArchivo: vi.fn().mockResolvedValue(undefined),
  eliminarCarpeta: vi.fn().mockResolvedValue(undefined),
}));

const { default: productsRouter } = await import("../routes/products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "3650d",
});
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
  productMock.findUnique.mockResolvedValue({
    id: 5,
    nombre: "Lámpara",
    sku: "LAM-01",
    fotos: [],
    video: null,
  });
});

describe("DELETE /products/:id — bloqueado si está en un combo", () => {
  it("409 nombrando el combo", async () => {
    comboItemMock.findMany.mockResolvedValue([{ combo: { id: 3, nombre: "Kit Living Cálido" } }]);
    const res = await request(buildApp())
      .delete("/api/products/5")
      .set("Authorization", authHeader);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Kit Living Cálido");
    expect(productMock.delete).not.toHaveBeenCalled();
  });

  it("sin combos, borra normal", async () => {
    comboItemMock.findMany.mockResolvedValue([]);
    productMock.delete.mockResolvedValue({});
    const res = await request(buildApp())
      .delete("/api/products/5")
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
  });
});

describe("GET /products/:id — suma combos", () => {
  const PRODUCTO = {
    id: 5,
    nombre: "Lámpara",
    sku: "LAM-01",
    precio: 10000,
    visibleEnCatalogo: true,
    stock: 9,
    fotos: [],
    caracteristicas: [],
    listas: [],
    especificaciones: [],
    etiqueta: null,
    categoria: null,
    categoriaId: null,
    etiquetaId: null,
    video: null,
    createdAt: new Date("2026-09-01T12:00:00Z"),
  };

  function enCombo(id, nombre) {
    return {
      combo: {
        id,
        nombre,
        frase: "Frase.",
        activo: true,
        vigencia: "SIEMPRE",
        porcentaje: 15,
        heroUrl: `https://x/${id}.jpg`,
        campanias: [],
        items: [
          { productId: 5, cantidad: 2, product: { id: 5, nombre: "Lámpara", precio: 10000, visibleEnCatalogo: true, stock: 9, categoria: null, fotos: [] } },
        ],
      },
    };
  }

  beforeEach(() => {
    productMock.findUnique.mockResolvedValue(PRODUCTO);
    productMock.update.mockResolvedValue(PRODUCTO);
  });

  it("trae los combos vigentes que incluyen el producto, con la forma pública", async () => {
    comboItemMock.findMany.mockResolvedValue([enCombo(1, "Kit Living Cálido")]);

    const res = await request(buildApp()).get("/api/products/5");

    expect(res.status).toBe(200);
    expect(res.body.combos).toEqual([
      expect.objectContaining({ id: 1, nombre: "Kit Living Cálido", precioSeparado: "20000", precioCombo: "17000", alcanza: 4, disponible: true }),
    ]);
  });

  it("pide solo vigentes, más nuevos primero, con tope de 6", async () => {
    comboItemMock.findMany.mockResolvedValue([]);

    await request(buildApp()).get("/api/products/5");

    expect(comboItemMock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ productId: 5, combo: expect.objectContaining({ activo: true }) }),
        orderBy: { combo: { createdAt: "desc" } },
        take: 6,
      }),
    );
  });

  it("sin combos, `combos` viaja como [] y no como clave ausente", async () => {
    comboItemMock.findMany.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/products/5");

    expect(res.body.combos).toEqual([]);
  });
});
