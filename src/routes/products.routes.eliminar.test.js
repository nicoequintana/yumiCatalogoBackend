import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const findUniqueMock = vi.fn();
const deleteMock = vi.fn();
const itemOrdenCountMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findUnique: (...args) => findUniqueMock(...args),
      delete: (...args) => deleteMock(...args),
    },
    itemOrden: { count: (...args) => itemOrdenCountMock(...args) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 1 }) },
  },
}));
vi.mock("../services/googleDrive.service.js", () => ({
  eliminarArchivo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/cloudinary.service.js", () => ({
  eliminarArchivo: vi.fn().mockResolvedValue(undefined),
  eliminarCarpeta: vi.fn().mockResolvedValue(undefined),
}));

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

const token = jwt.sign({ sub: 1, email: "admin@yima.test" }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

const productoBase = {
  id: 42,
  nombre: "Bruma Facial",
  sku: "YIMA-BRUMAF-1234",
  fotos: [],
  video: null,
  driveFolderId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  itemOrdenCountMock.mockResolvedValue(0);
});

describe("DELETE /api/products/:id con historial de ventas", () => {
  // `ItemOrden.product` es `onDelete: NoAction`, así que borrar un producto
  // que aparece en alguna orden explota con el error P2003 de Prisma, que el
  // error handler central no mapea: el admin veía "Error interno del
  // servidor." sin ninguna pista de qué hacer. Mismo criterio de pre-chequeo
  // que `categorias.controller.js` usa con los productos de una categoría.
  it("devuelve 400 con un mensaje accionable si el producto tiene ventas", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase });
    itemOrdenCountMock.mockResolvedValue(3);

    const res = await request(buildApp()).delete("/api/products/42").set("Authorization", authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no se puede eliminar/i);
    expect(res.body.error).toContain("3");
    expect(res.body.error).toMatch(/ocult/i);
    expect(res.body.error).toContain("órdenes");
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("singulariza el mensaje cuando hay una sola venta", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase });
    itemOrdenCountMock.mockResolvedValue(1);

    const res = await request(buildApp()).delete("/api/products/42").set("Authorization", authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("1 orden de compra");
    expect(res.body.error).not.toContain("órdenes");
  });

  it("cuenta los ItemOrden del producto por su índice de productId", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase });
    itemOrdenCountMock.mockResolvedValue(0);

    await request(buildApp()).delete("/api/products/42").set("Authorization", authHeader);

    expect(itemOrdenCountMock).toHaveBeenCalledWith({ where: { productId: 42 } });
  });

  it("borra normalmente cuando el producto no tiene ventas", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase });
    itemOrdenCountMock.mockResolvedValue(0);
    deleteMock.mockResolvedValue({ id: 42 });

    const res = await request(buildApp()).delete("/api/products/42").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 42 } });
  });

  it("no cuenta ventas si el producto ni siquiera existe (404 primero)", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).delete("/api/products/999").set("Authorization", authHeader);

    expect(res.status).toBe(404);
    expect(itemOrdenCountMock).not.toHaveBeenCalled();
  });
});
