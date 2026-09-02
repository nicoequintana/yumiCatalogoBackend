import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const updateMock = vi.fn();
const findUniqueMock = vi.fn();
const findManyMock = vi.fn();
const countMock = vi.fn().mockResolvedValue(0);
const findUniqueOrThrowMock = vi.fn();
const deleteMock = vi.fn();
const fotoFindUniqueMock = vi.fn();
const itemOrdenCountMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    // `requireAuth` lee la fila del usuario para verificar la revocación de
    // sesión Y el permiso de borrado (`puedeEliminar`). Sin este mock la
    // consulta lanza y el middleware de borrado niega por fail-closed.
    usuario: { findUnique: vi.fn().mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true }) },
    product: {
      update: (...args) => updateMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      findMany: (...args) => findManyMock(...args),
      count: (...args) => countMock(...args),
      findUniqueOrThrow: (...args) => findUniqueOrThrowMock(...args),
      delete: (...args) => deleteMock(...args),
    },
    foto: { findUnique: (...args) => fotoFindUniqueMock(...args) },
    // `eliminar` pre-chequea el historial de ventas antes de borrar.
    itemOrden: { count: (...args) => itemOrdenCountMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    $transaction: async (fn) =>
      fn({
        product: {
          update: (...args) => updateMock(...args),
          findUniqueOrThrow: (...args) => findUniqueOrThrowMock(...args),
        },
        foto: { delete: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
      }),
  },
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

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

const productoBase = {
  id: 42,
  nombre: "Bruma Facial",
  sku: "YIMA-BRUMAF-1234",
  precio: "100",
  etiqueta: null,
  categoria: null,
  caracteristicas: [],
  listas: [],
  especificaciones: [],
  fotos: [],
  video: null,
  vistas: 0,
  compartidos: 0,
  visibleEnCatalogo: true,
  stock: 10,
  destacado: false,
  orden: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  itemOrdenCountMock.mockResolvedValue(0);
  auditCreateMock.mockResolvedValue({ id: 1 });
});

describe("auditoría de PATCH /api/products/:id/visibilidad", () => {
  it("registra en AuditLog el cambio de visibilidad, con el valor anterior y el nuevo", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase, visibleEnCatalogo: true });
    updateMock.mockResolvedValue({ ...productoBase, visibleEnCatalogo: false });

    const res = await request(buildApp())
      .patch("/api/products/42/visibilidad")
      .set("Authorization", authHeader)
      .send({ visibleEnCatalogo: false });

    expect(res.status).toBe(200);
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ACTUALIZAR_VISIBILIDAD",
        entidad: "Producto",
        entidadId: 42,
        usuarioEmail: "admin@yima.test",
        detalle: JSON.stringify({ visibleAnterior: true, visibleNuevo: false }),
      }),
    });
  });

  it("NO registra nada en AuditLog si la validación falla (no hubo mutación)", async () => {
    const res = await request(buildApp())
      .patch("/api/products/42/visibilidad")
      .set("Authorization", authHeader)
      .send({ visibleEnCatalogo: "no-es-boolean" });

    expect(res.status).toBe(400);
    expect(auditCreateMock).not.toHaveBeenCalled();
  });
});

describe("auditoría de PATCH /api/products/:id/merchandising", () => {
  it("registra en AuditLog el cambio de merchandising", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase, destacado: false, orden: 0 });
    updateMock.mockResolvedValue({ ...productoBase, destacado: true, orden: 5 });

    const res = await request(buildApp())
      .patch("/api/products/42/merchandising")
      .set("Authorization", authHeader)
      .send({ destacado: true, orden: 5 });

    expect(res.status).toBe(200);
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ACTUALIZAR_MERCHANDISING",
        entidad: "Producto",
        entidadId: 42,
      }),
    });
  });
});

describe("auditoría de DELETE /api/products/:id", () => {
  it("registra en AuditLog la eliminación, con nombre y sku del producto borrado", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase, fotos: [], video: null });
    deleteMock.mockResolvedValue({ id: 42 });

    const res = await request(buildApp()).delete("/api/products/42").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ELIMINAR",
        entidad: "Producto",
        entidadId: 42,
        detalle: JSON.stringify({ nombre: "Bruma Facial", sku: "YIMA-BRUMAF-1234" }),
      }),
    });
  });

  it("NO registra nada en AuditLog si el producto no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).delete("/api/products/999").set("Authorization", authHeader);

    expect(res.status).toBe(404);
    expect(auditCreateMock).not.toHaveBeenCalled();
  });
});

describe("auditoría de las lecturas públicas", () => {
  it("GET /api/products NO registra nada en AuditLog (las lecturas no se auditan)", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products");

    expect(auditCreateMock).not.toHaveBeenCalled();
  });
});
