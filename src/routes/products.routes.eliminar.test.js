import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

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
  app.use(manejadorDeErrores);
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
  // `ItemOrden.productId` es nullable con `onDelete: SetNull`: borrar un
  // producto DESLIGA sus líneas históricas en vez de quedar bloqueado por
  // ellas. La orden conserva su contenido legible gracias a los snapshots
  // `nombreProducto` y `precioUnitario`.
  //
  // Antes acá había un pre-chequeo que devolvía 400 y recomendaba ocultar el
  // producto. Se quitó a pedido explícito: volvía imborrable a cualquier
  // producto que apareciera en una orden, incluidas las CANCELADAS, que este
  // proyecto no cuenta como ventas.
  it("borra el producto aunque aparezca en órdenes de compra", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase });
    itemOrdenCountMock.mockResolvedValue(3);
    deleteMock.mockResolvedValue({ id: 42 });

    const res = await request(buildApp()).delete("/api/products/42").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 42 } });
  });

  it("no consulta ItemOrden para decidir: la FK lo resuelve sola", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase });
    deleteMock.mockResolvedValue({ id: 42 });

    await request(buildApp()).delete("/api/products/42").set("Authorization", authHeader);

    expect(itemOrdenCountMock).not.toHaveBeenCalled();
  });

  it("borra normalmente cuando el producto no tiene ventas", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase });
    deleteMock.mockResolvedValue({ id: 42 });

    const res = await request(buildApp()).delete("/api/products/42").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 42 } });
  });

  it("responde 404 si el producto ni siquiera existe, sin borrar nada", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).delete("/api/products/999").set("Authorization", authHeader);

    expect(res.status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
