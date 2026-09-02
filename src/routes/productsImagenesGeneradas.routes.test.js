import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

/**
 * Las tres rutas de la carpeta de imágenes generadas por n8n.
 *
 * Cloudinary está mockeado: la suite no sale a la red.
 *
 * La regla que más importa acá es la del borrado: las imágenes ADOPTADAS son
 * los mismos archivos que las fotos del producto, así que borrarlas dejaría el
 * catálogo con URLs en 404 sin ningún error de este lado.
 */

process.env.JWT_SECRET = "test-secret";

const productFindUniqueMock = vi.fn();
const fotoCreateManyMock = vi.fn();
const transactionMock = vi.fn();
const listarMock = vi.fn();
const eliminarArchivoMock = vi.fn();
const eliminarCarpetaMock = vi.fn();
const logAuditMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: { findUnique: (...args) => productFindUniqueMock(...args) },
    foto: { createMany: (...args) => fotoCreateManyMock(...args) },
    $transaction: (...args) => transactionMock(...args),
  },
}));
vi.mock("../services/cloudinary.service.js", () => ({
  listarImagenesDeCarpeta: (...args) => listarMock(...args),
  eliminarArchivo: (...args) => eliminarArchivoMock(...args),
  eliminarCarpeta: (...args) => eliminarCarpetaMock(...args),
  subirArchivo: vi.fn(),
}));
vi.mock("../services/n8n.service.js", () => ({
  enviarPedidoDeImagenes: vi.fn(),
  estaConfigurado: () => true,
  MAX_REFERENCIAS: 4,
}));
vi.mock("../lib/logAudit.js", () => ({ logAudit: (...args) => logAuditMock(...args) }));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ id: 1, email: "admin@yima.local", tokenVersion: 0 }, process.env.JWT_SECRET);
const BASE = "/api/products/7/imagenes-generadas";

/** Producto con dos fotos, una de ellas adoptada de la carpeta generada. */
function producto(fotos = []) {
  return { id: 7, sku: "YIMA-TERMOM-8189", nombre: "Termo mate", fotos };
}

const GENERADAS = [
  { publicId: "productos/YIMA-TERMOM-8189/YIMA-TERMOM-8189-1", url: "u1", nombre: "YIMA-TERMOM-8189-1" },
  { publicId: "productos/YIMA-TERMOM-8189/YIMA-TERMOM-8189-2", url: "u2", nombre: "YIMA-TERMOM-8189-2" },
  { publicId: "productos/YIMA-TERMOM-8189/YIMA-TERMOM-8189-3", url: "u3", nombre: "YIMA-TERMOM-8189-3" },
];

describe("imágenes generadas de un producto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    productFindUniqueMock.mockResolvedValue(producto());
    listarMock.mockResolvedValue(GENERADAS);
    transactionMock.mockImplementation(async (fn) =>
      fn({
        product: { findUnique: (...a) => productFindUniqueMock(...a) },
        foto: { createMany: (...a) => fotoCreateManyMock(...a) },
      }),
    );
  });

  describe("GET (listar)", () => {
    it("sin token responde 401", async () => {
      const res = await request(buildApp()).get(BASE);
      expect(res.status).toBe(401);
    });

    it("consulta la carpeta del sku del producto", async () => {
      await request(buildApp()).get(BASE).set("Authorization", `Bearer ${token}`);
      expect(listarMock).toHaveBeenCalledWith("productos/YIMA-TERMOM-8189");
    });

    it("marca como adoptadas las que ya son fotos del producto", async () => {
      productFindUniqueMock.mockResolvedValue(
        producto([{ id: 1, cloudinaryPublicId: GENERADAS[0].publicId, orden: 0 }]),
      );

      const res = await request(buildApp()).get(BASE).set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.carpeta).toBe("productos/YIMA-TERMOM-8189");
      expect(res.body.imagenes.map((i) => i.adoptada)).toEqual([true, false, false]);
    });

    it("una carpeta vacía devuelve lista vacía y no un error", async () => {
      listarMock.mockResolvedValue([]);
      const res = await request(buildApp()).get(BASE).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.imagenes).toEqual([]);
    });

    it("404 si el producto no existe", async () => {
      productFindUniqueMock.mockResolvedValue(null);
      const res = await request(buildApp()).get(BASE).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  describe("POST (adoptar)", () => {
    it("crea una fila Foto por cada publicId, con orden correlativo", async () => {
      const res = await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: [GENERADAS[0].publicId, GENERADAS[1].publicId] });

      expect(res.status).toBe(200);
      const data = fotoCreateManyMock.mock.calls[0][0].data;
      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({
        productId: 7,
        cloudinaryPublicId: GENERADAS[0].publicId,
        cloudinaryResourceType: "image",
        url: "u1",
        orden: 0,
      });
      expect(data[1].orden).toBe(1);
    });

    it("continúa la secuencia de orden después de las fotos que ya existen", async () => {
      // `Foto.orden` es compacto y sin huecos: empezar en 0 duplicaría la
      // portada y dejaría el orden indefinido.
      productFindUniqueMock.mockResolvedValue(
        producto([
          { id: 1, cloudinaryPublicId: "otra-a", orden: 0 },
          { id: 2, cloudinaryPublicId: "otra-b", orden: 1 },
        ]),
      );

      await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: [GENERADAS[0].publicId] });

      expect(fotoCreateManyMock.mock.calls[0][0].data[0].orden).toBe(2);
    });

    it("rechaza ENTERA una selección que no entra en el tope de 10", async () => {
      // Adoptar las primeras N en silencio es lo que hace dudar de si el
      // sistema funcionó.
      productFindUniqueMock.mockResolvedValue(
        producto(Array.from({ length: 9 }, (_, i) => ({ id: i, cloudinaryPublicId: `x${i}`, orden: i }))),
      );

      const res = await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: [GENERADAS[0].publicId, GENERADAS[1].publicId, GENERADAS[2].publicId] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/1/);
      expect(fotoCreateManyMock).not.toHaveBeenCalled();
    });

    it("rechaza un publicId que no está en la carpeta del producto", async () => {
      // Sin esto, un request armado a mano adoptaría la imagen de otro producto.
      const res = await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: ["productos/OTRO-SKU/OTRO-1"] });

      expect(res.status).toBe(400);
      expect(fotoCreateManyMock).not.toHaveBeenCalled();
    });

    it("rechaza una lista vacía", async () => {
      const res = await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: [] });

      expect(res.status).toBe(400);
    });

    it("no vuelve a adoptar una imagen que ya es foto del producto", async () => {
      productFindUniqueMock.mockResolvedValue(
        producto([{ id: 1, cloudinaryPublicId: GENERADAS[0].publicId, orden: 0 }]),
      );

      const res = await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: [GENERADAS[0].publicId] });

      expect(res.status).toBe(400);
      expect(fotoCreateManyMock).not.toHaveBeenCalled();
    });

    it("deja rastro en AuditLog", async () => {
      await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: [GENERADAS[0].publicId] });

      expect(logAuditMock.mock.calls[0][1]).toMatchObject({
        accion: "ADOPTAR_IMAGENES",
        entidad: "Producto",
        entidadId: 7,
      });
    });

    it("deduplica publicIds repetidos antes de crear filas", async () => {
      // Sin esto, dos filas Foto apuntan al mismo archivo de Cloudinary:
      // quitar una destruye el archivo que la otra sigue usando.
      const res = await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: [GENERADAS[0].publicId, GENERADAS[0].publicId] });

      expect(res.status).toBe(200);
      expect(fotoCreateManyMock.mock.calls[0][0].data).toHaveLength(1);
      expect(res.body.agregadas).toBe(1);
    });

    it("lee las FOTOS del producto DENTRO de la transacción, no antes", async () => {
      // El tope (`libres`/`desde`) tiene que calcularse con el mismo estado que
      // ve la inserción. Leer `producto.fotos` afuera del `$transaction` deja a
      // dos `adoptar` concurrentes viendo el mismo conteo viejo.
      //
      // El sku SÍ puede leerse afuera (no cambia, no es parte de la carrera):
      // por eso acá solo se exige que, para cuando entra a la transacción, la
      // llamada que trae `fotos` (identificable por su `select`) todavía no
      // se hizo.
      transactionMock.mockImplementation(async (fn) => {
        const yaLeyoFotos = productFindUniqueMock.mock.calls.some(
          (llamada) => llamada[0]?.select?.fotos,
        );
        expect(yaLeyoFotos).toBe(false);
        return fn({
          product: { findUnique: (...a) => productFindUniqueMock(...a) },
          foto: { createMany: (...a) => fotoCreateManyMock(...a) },
        });
      });

      const res = await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: [GENERADAS[0].publicId] });

      expect(res.status).toBe(200);
      // Una lectura afuera (sku, para armar la carpeta) y una adentro (fotos,
      // para el conteo) — dos en total, y la segunda es la que trae `fotos`.
      expect(productFindUniqueMock).toHaveBeenCalledTimes(2);
      expect(productFindUniqueMock.mock.calls[1][0].select).toHaveProperty("fotos");
    });

    it("consulta Cloudinary AFUERA de la transacción", async () => {
      // `listarImagenesDeCarpeta` es HTTP externo (el SDK de Cloudinary usa un
      // timeout de 60s) y no puede correr dentro del `$transaction`: el
      // default de Prisma para transacciones interactivas es 5s, así que una
      // respuesta lenta abortaría la transacción con P2028 — no mapeado por
      // el error handler central, un 500 sobre una operación que antes andaba.
      transactionMock.mockImplementation(async (fn) => {
        expect(listarMock).toHaveBeenCalledTimes(1);
        return fn({
          product: { findUnique: (...a) => productFindUniqueMock(...a) },
          foto: { createMany: (...a) => fotoCreateManyMock(...a) },
        });
      });

      const res = await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: [GENERADAS[0].publicId] });

      expect(res.status).toBe(200);
      expect(listarMock).toHaveBeenCalledTimes(1);
    });

    it("corre en una transacción Serializable", async () => {
      await request(buildApp())
        .post(`${BASE}/adoptar`)
        .set("Authorization", `Bearer ${token}`)
        .send({ publicIds: [GENERADAS[0].publicId] });

      expect(transactionMock.mock.calls[0][1]).toEqual({ isolationLevel: "Serializable" });
    });
  });

  describe("DELETE (borrar generadas)", () => {
    it("NO borra las imágenes adoptadas", async () => {
      // Son los mismos archivos que las fotos del producto: borrarlas deja el
      // catálogo público con URLs en 404 y sin ningún error de este lado.
      productFindUniqueMock.mockResolvedValue(
        producto([{ id: 1, cloudinaryPublicId: GENERADAS[0].publicId, orden: 0 }]),
      );

      const res = await request(buildApp()).delete(BASE).set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      const borrados = eliminarArchivoMock.mock.calls.map((c) => c[0]);
      expect(borrados).not.toContain(GENERADAS[0].publicId);
      expect(borrados).toEqual([GENERADAS[1].publicId, GENERADAS[2].publicId]);
    });

    it("con adoptadas presentes NO borra la carpeta y lo informa", async () => {
      productFindUniqueMock.mockResolvedValue(
        producto([{ id: 1, cloudinaryPublicId: GENERADAS[0].publicId, orden: 0 }]),
      );

      const res = await request(buildApp()).delete(BASE).set("Authorization", `Bearer ${token}`);

      expect(eliminarCarpetaMock).not.toHaveBeenCalled();
      expect(res.body.carpetaBorrada).toBe(false);
      expect(res.body.conservadas).toBe(1);
    });

    it("sin adoptadas borra todo y elimina la carpeta", async () => {
      const res = await request(buildApp()).delete(BASE).set("Authorization", `Bearer ${token}`);

      expect(eliminarArchivoMock).toHaveBeenCalledTimes(3);
      expect(eliminarCarpetaMock).toHaveBeenCalledWith("productos/YIMA-TERMOM-8189");
      expect(res.body.carpetaBorrada).toBe(true);
      expect(res.body.borradas).toBe(3);
    });

    it("sin token responde 401", async () => {
      const res = await request(buildApp()).delete(BASE);
      expect(res.status).toBe(401);
    });
  });
});
