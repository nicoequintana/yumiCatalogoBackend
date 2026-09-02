import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * Acciones masivas del listado del admin: ocultar/mostrar y eliminar varios
 * productos seleccionados con checkbox.
 *
 * Lo que estas suites fijan, más allá del camino feliz:
 *
 *   1. **El borrado masivo es PARCIAL por diseño.** Un producto que aparece
 *      en una orden no se puede borrar (`ItemOrden.product` es
 *      `onDelete: NoAction`), y en una selección grande eso es el caso
 *      frecuente, no el raro. La respuesta tiene que distinguir qué se
 *      eliminó de qué se rechazó y por qué — un "listo" que borró 38 de 50
 *      es una mentira.
 *   2. **Las rutas masivas no pueden ser tragadas por `/:id`.** Van
 *      declaradas antes; si alguien las mueve, `visibilidad-masiva` se
 *      matchea como un id y estos tests se caen.
 *   3. **El tope de ids es el mismo `MAX_IDS_LISTADO` del listado**, y
 *      pasarse es un 400, nunca un truncado silencioso.
 */

const updateManyMock = vi.fn();
const findManyMock = vi.fn();
const findUniqueMock = vi.fn();
const deleteMock = vi.fn();
const itemOrdenCountMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      updateMany: (...args) => updateManyMock(...args),
      findMany: (...args) => findManyMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      delete: (...args) => deleteMock(...args),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
    },
    itemOrden: { count: (...args) => itemOrdenCountMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    usuario: { findUnique: vi.fn().mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true }) },
    eventoTrafico: { create: vi.fn().mockResolvedValue({ id: 1 }) },
  },
}));
const eliminarCarpetaMock = vi.fn().mockResolvedValue(undefined);
const limpiarMediaRemotaMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/cloudinary.service.js", () => ({
  eliminarCarpeta: (...args) => eliminarCarpetaMock(...args),
}));
vi.mock("../services/productoMedia.service.js", () => ({
  limpiarArchivosSubidos: vi.fn().mockResolvedValue(undefined),
  limpiarMediaRemota: (...args) => limpiarMediaRemotaMock(...args),
  logFallaDeLimpieza: vi.fn(),
  sanitizarNombreParaCarpeta: (nombre) => nombre,
  subirArchivosNuevos: vi.fn().mockResolvedValue({ fotos: [], video: null }),
}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

function tokenValido() {
  return jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
    expiresIn: "7d",
  });
}

function conAuth(peticion) {
  return peticion.set("Authorization", `Bearer ${tokenValido()}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  itemOrdenCountMock.mockResolvedValue(0);
  auditCreateMock.mockResolvedValue({ id: 1 });
  deleteMock.mockResolvedValue({});
});

describe("PATCH /api/products/visibilidad-masiva", () => {
  it("oculta todos los ids pedidos con un solo updateMany", async () => {
    updateManyMock.mockResolvedValue({ count: 3 });

    const res = await conAuth(request(buildApp()).patch("/api/products/visibilidad-masiva")).send({
      ids: [1, 2, 3],
      visible: false,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ actualizados: 3 });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: [1, 2, 3] } },
      data: { visibleEnCatalogo: false },
    });
  });

  it("acepta visible: true para volver a mostrarlos", async () => {
    updateManyMock.mockResolvedValue({ count: 2 });

    const res = await conAuth(request(buildApp()).patch("/api/products/visibilidad-masiva")).send({
      ids: [7, 9],
      visible: true,
    });

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: [7, 9] } },
      data: { visibleEnCatalogo: true },
    });
  });

  it("audita un renglon POR PRODUCTO, no uno por lote", async () => {
    updateManyMock.mockResolvedValue({ count: 2 });

    await conAuth(request(buildApp()).patch("/api/products/visibilidad-masiva")).send({
      ids: [4, 5],
      visible: false,
    });

    expect(auditCreateMock).toHaveBeenCalledTimes(2);
    const idsAuditados = auditCreateMock.mock.calls.map((c) => c[0].data.entidadId);
    expect(idsAuditados).toEqual([4, 5]);
  });

  it("rechaza con 401 sin token, sin tocar la base", async () => {
    const res = await request(buildApp())
      .patch("/api/products/visibilidad-masiva")
      .send({ ids: [1], visible: false });

    expect(res.status).toBe(401);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("rechaza con 400 una lista vacia", async () => {
    const res = await conAuth(request(buildApp()).patch("/api/products/visibilidad-masiva")).send({
      ids: [],
      visible: false,
    });

    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("rechaza con 400 mas de 100 ids en vez de truncar en silencio", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);

    const res = await conAuth(request(buildApp()).patch("/api/products/visibilidad-masiva")).send({
      ids,
      visible: false,
    });

    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("rechaza con 400 si visible no es booleano", async () => {
    const res = await conAuth(request(buildApp()).patch("/api/products/visibilidad-masiva")).send({
      ids: [1],
      visible: "si",
    });

    expect(res.status).toBe(400);
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/products/eliminar-masivo", () => {
  it("elimina los productos sin ventas y los informa", async () => {
    findManyMock.mockResolvedValue([
      { id: 1, nombre: "Termo", sku: "YIMA-TERMO-1111", fotos: [], video: null },
      { id: 2, nombre: "Mate", sku: "YIMA-MATE-2222", fotos: [], video: null },
    ]);

    const res = await conAuth(request(buildApp()).post("/api/products/eliminar-masivo")).send({
      ids: [1, 2],
    });

    expect(res.status).toBe(200);
    expect(res.body.eliminados).toEqual([1, 2]);
    expect(res.body.rechazados).toEqual([]);
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  it("elimina tambien los productos que aparecen en ordenes", async () => {
    findManyMock.mockResolvedValue([
      { id: 1, nombre: "Termo", sku: "YIMA-TERMO-1111", fotos: [], video: null },
      { id: 2, nombre: "Mate vendido", sku: "YIMA-MATE-2222", fotos: [], video: null },
    ]);
    // El id 2 aparece en 3 órdenes. Desde `onDelete: SetNull` eso ya no lo
    // bloquea: la base desliga las líneas y la orden conserva sus snapshots.
    itemOrdenCountMock.mockImplementation(({ where }) =>
      Promise.resolve(where.productId === 2 ? 3 : 0),
    );

    const res = await conAuth(request(buildApp()).post("/api/products/eliminar-masivo")).send({
      ids: [1, 2],
    });

    expect(res.status).toBe(200);
    expect(res.body.eliminados).toEqual([1, 2]);
    expect(res.body.rechazados).toEqual([]);
    expect(deleteMock).toHaveBeenCalledTimes(2);
  });

  it("informa como rechazado un id que no existe, sin cortar el lote", async () => {
    findManyMock.mockResolvedValue([
      { id: 1, nombre: "Termo", sku: "YIMA-TERMO-1111", fotos: [], video: null },
    ]);

    const res = await conAuth(request(buildApp()).post("/api/products/eliminar-masivo")).send({
      ids: [1, 999],
    });

    expect(res.status).toBe(200);
    expect(res.body.eliminados).toEqual([1]);
    expect(res.body.rechazados).toEqual([
      { id: 999, nombre: null, motivo: "El producto no existe." },
    ]);
  });

  it("audita un renglon POR PRODUCTO eliminado, ninguno por los rechazados", async () => {
    // Solo existe el id 1; el 999 se informa como rechazado y no se audita.
    findManyMock.mockResolvedValue([
      { id: 1, nombre: "Termo", sku: "YIMA-TERMO-1111", fotos: [], video: null },
    ]);

    await conAuth(request(buildApp()).post("/api/products/eliminar-masivo")).send({ ids: [1, 999] });

    expect(auditCreateMock).toHaveBeenCalledTimes(1);
    expect(auditCreateMock.mock.calls[0][0].data.entidadId).toBe(1);
  });

  // El borrado masivo tiene que limpiar Cloudinary igual que el individual: si
  // solo borrara las filas, cada limpieza de catálogo dejaría carpetas y
  // archivos huérfanos acumulándose y facturando.
  describe("limpieza de medios", () => {
    const CON_MEDIA = [
      {
        id: 1,
        nombre: "Termo",
        sku: "YIMA-TERMO-1111",
        driveFolderId: null,
        fotos: [{ id: 10, cloudinaryPublicId: "c10" }, { id: 11, cloudinaryPublicId: "c11" }],
        video: { id: 5, cloudinaryPublicId: "cv" },
      },
      {
        id: 2,
        nombre: "Mate",
        sku: "YIMA-MATE-2222",
        driveFolderId: null,
        fotos: [{ id: 20, cloudinaryPublicId: "c20" }],
        video: null,
      },
    ];

    it("borra la carpeta de Cloudinary de CADA producto eliminado", async () => {
      findManyMock.mockResolvedValue(CON_MEDIA);

      await conAuth(request(buildApp()).post("/api/products/eliminar-masivo")).send({ ids: [1, 2] });

      // Misma fórmula de nombre que usan crear/actualizar, o la carpeta no
      // coincide y queda viva para siempre.
      expect(eliminarCarpetaMock).toHaveBeenCalledWith("productos/1-Termo");
      expect(eliminarCarpetaMock).toHaveBeenCalledWith("productos/2-Mate");
      expect(eliminarCarpetaMock).toHaveBeenCalledTimes(2);
    });

    it("barre los archivos de cada producto antes que su carpeta", async () => {
      findManyMock.mockResolvedValue(CON_MEDIA);

      await conAuth(request(buildApp()).post("/api/products/eliminar-masivo")).send({ ids: [1, 2] });

      // 2 fotos + 1 video del primero, 1 foto del segundo.
      expect(limpiarMediaRemotaMock).toHaveBeenCalledTimes(4);
    });

    it("no borra ninguna carpeta si no se elimino ningun producto", async () => {
      findManyMock.mockResolvedValue([]);

      await conAuth(request(buildApp()).post("/api/products/eliminar-masivo")).send({ ids: [999] });

      expect(eliminarCarpetaMock).not.toHaveBeenCalled();
    });
  });

  it("rechaza con 401 sin token, sin tocar la base", async () => {
    const res = await request(buildApp())
      .post("/api/products/eliminar-masivo")
      .send({ ids: [1] });

    expect(res.status).toBe(401);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("rechaza con 400 mas de 100 ids en vez de truncar en silencio", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);

    const res = await conAuth(request(buildApp()).post("/api/products/eliminar-masivo")).send({
      ids,
    });

    expect(res.status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("rechaza con 400 una lista vacia", async () => {
    const res = await conAuth(request(buildApp()).post("/api/products/eliminar-masivo")).send({
      ids: [],
    });

    expect(res.status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });
});
