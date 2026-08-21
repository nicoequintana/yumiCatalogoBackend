import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

// La vista admin de estos endpoints públicos la habilita el JWT verificado, no
// `?admin=1` (ver products.routes.autorizacion.test.js).
const authHeader = `Bearer ${jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" })}`;

const findManyMock = vi.fn();
const countMock = vi.fn().mockResolvedValue(0);
const findUniqueMock = vi.fn();
const updateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findMany: (...args) => findManyMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      update: (...args) => updateMock(...args),
      count: (...args) => countMock(...args),
    },
  },
}));
vi.mock("../services/googleDrive.service.js", () => ({}));
vi.mock("../services/cloudinary.service.js", () => ({}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

const productoBase = {
  id: 42,
  nombre: "Bruma Facial",
  sku: "YIMA-BRUMAF-1234",
  descripcion: "Descripción",
  precio: "100",
  etiqueta: null,
  categoriaId: null,
  categoria: null,
  caracteristicas: [],
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
  findManyMock.mockReset();
  findUniqueMock.mockReset();
  updateMock.mockReset();
});

describe("GET /api/products - filtros de listado", () => {
  it("filtra por categoria (numérico)", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?categoria=3");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 }, categoriaId: 3 });
  });

  it("search busca en nombre, sku y categoría (contains, sin mode)", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?search=bruma");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({
      visibleEnCatalogo: true,
      stock: { gt: 0 },
      OR: [
        { nombre: { contains: "bruma" } },
        { sku: { contains: "bruma" } },
        { categoria: { nombre: { contains: "bruma" } } },
      ],
    });
  });

  it("search por SKU encuentra el producto aunque no coincida el nombre", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?search=YIM-0042");

    const { where } = findManyMock.mock.calls[0][0];
    // El SKU es una de las tres ramas del OR: quien lo tipea no tiene que
    // declarar que está buscando por código.
    expect(where.OR).toContainEqual({ sku: { contains: "YIM-0042" } });
  });

  it("search vacío no filtra nada", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?search=");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 } });
  });

  it("search con solo espacios no filtra nada", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?search=%20%20%20");

    // Sin el `trim`, un `contains: "   "` devolvería la tabla casi vacía sin
    // que el usuario entienda por qué.
    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 } });
  });

  it("recorta los espacios alrededor del término", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?search=%20bruma%20");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.OR).toContainEqual({ nombre: { contains: "bruma" } });
  });

  it("search compone con las guardas públicas, no las reemplaza", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?search=bruma");

    // Un OR mal ubicado se llevaría puestas las guardas de visibilidad/stock
    // y expondría productos ocultos a un anónimo. Prisma une las claves de
    // primer nivel con AND, así que el OR queda acotado dentro de ellas.
    const { where } = findManyMock.mock.calls[0][0];
    expect(where.visibleEnCatalogo).toBe(true);
    expect(where.stock).toEqual({ gt: 0 });
  });

  it("filtra por minPrecio", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?minPrecio=50");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 }, precio: { gte: 50 } });
  });

  it("filtra por maxPrecio", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?maxPrecio=200");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 }, precio: { lte: 200 } });
  });

  it("combina minPrecio y maxPrecio en un rango", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?minPrecio=50&maxPrecio=200");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 }, precio: { gte: 50, lte: 200 } });
  });

  it("ignora minPrecio malformado sin romper (200, filtro descartado)", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/products?minPrecio=abc");

    expect(res.status).toBe(200);
    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 } });
  });

  it("ignora categoria malformada sin romper (200, filtro descartado)", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/products?categoria=abc");

    expect(res.status).toBe(200);
    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 } });
  });

  it("combina múltiples filtros con AND, visibleEnCatalogo primero en modo público", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get(
      "/api/products?categoria=3&search=bruma&minPrecio=50&maxPrecio=200",
    );

    const { where } = findManyMock.mock.calls[0][0];
    const keys = Object.keys(where);
    expect(keys[0]).toBe("visibleEnCatalogo");
    expect(keys[1]).toBe("stock");
    expect(where).toEqual({
      visibleEnCatalogo: true,
      stock: { gt: 0 },
      categoriaId: 3,
      OR: [
        { nombre: { contains: "bruma" } },
        { sku: { contains: "bruma" } },
        { categoria: { nombre: { contains: "bruma" } } },
      ],
      precio: { gte: 50, lte: 200 },
    });
  });

  it("modo admin (autenticado): sin visibleEnCatalogo ni stock, filtros igual aplican", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp())
      .get("/api/products?admin=1&categoria=3")
      .set("Authorization", authHeader);

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ categoriaId: 3 });
    expect(where.visibleEnCatalogo).toBeUndefined();
    expect(where.stock).toBeUndefined();
  });

  it("modo admin (autenticado) sin filtros: where undefined", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?admin=1").set("Authorization", authHeader);

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toBeUndefined();
  });

  it("modo público sin filtros: solo visibleEnCatalogo y stock", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 } });
  });
});

describe("GET /api/products/:id - relacionados", () => {
  it("incluye relacionados cuando hay match por categoriaId", async () => {
    const principal = { ...productoBase, id: 1, categoriaId: 5, etiqueta: null };
    const relacionado = { ...productoBase, id: 2, categoriaId: 5 };

    findUniqueMock.mockResolvedValueOnce(principal); // existencia
    updateMock.mockResolvedValue({ ...principal, vistas: 1 }); // fetch con include (incrementa vistas)
    findManyMock.mockResolvedValue([relacionado]);

    const res = await request(buildApp()).get("/api/products/1");

    expect(res.status).toBe(200);
    expect(res.body.relacionados).toHaveLength(1);
    expect(res.body.relacionados[0].id).toBe(2);

    const args = findManyMock.mock.calls[0][0];
    expect(args.where.id).toEqual({ not: 1 });
    expect(args.take).toBe(4);
  });

  it("incluye relacionados cuando hay match por etiqueta", async () => {
    const principal = { ...productoBase, id: 1, categoriaId: null, etiqueta: "Nuevo" };
    const relacionado = { ...productoBase, id: 3, etiqueta: "Nuevo" };

    findUniqueMock.mockResolvedValueOnce(principal);
    updateMock.mockResolvedValue({ ...principal, vistas: 1 });
    findManyMock.mockResolvedValue([relacionado]);

    const res = await request(buildApp()).get("/api/products/1");

    expect(res.status).toBe(200);
    expect(res.body.relacionados).toHaveLength(1);
    expect(res.body.relacionados[0].id).toBe(3);
  });

  it("devuelve array vacío sin consultar la BD si no hay categoriaId ni etiqueta", async () => {
    const principal = { ...productoBase, id: 1, categoriaId: null, etiqueta: null };

    findUniqueMock.mockResolvedValueOnce(principal);
    updateMock.mockResolvedValue({ ...principal, vistas: 1 });

    const res = await request(buildApp()).get("/api/products/1");

    expect(res.status).toBe(200);
    expect(res.body.relacionados).toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("excluye el propio producto y limita a 4", async () => {
    const principal = { ...productoBase, id: 1, categoriaId: 5 };
    findUniqueMock.mockResolvedValueOnce(principal);
    updateMock.mockResolvedValue({ ...principal, vistas: 1 });
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products/1");

    const args = findManyMock.mock.calls[0][0];
    expect(args.where.id).toEqual({ not: 1 });
    expect(args.take).toBe(4);
  });

  it("modo público: relacionados respetan visibleEnCatalogo true", async () => {
    const principal = { ...productoBase, id: 1, categoriaId: 5 };
    findUniqueMock.mockResolvedValueOnce(principal);
    updateMock.mockResolvedValue({ ...principal, vistas: 1 });
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products/1");

    const args = findManyMock.mock.calls[0][0];
    expect(args.where.visibleEnCatalogo).toBe(true);
  });

  it("modo admin (autenticado): relacionados NO filtran por visibleEnCatalogo", async () => {
    const principal = { ...productoBase, id: 1, categoriaId: 5 };
    findUniqueMock.mockResolvedValueOnce(principal); // existencia
    findUniqueMock.mockResolvedValueOnce({ ...principal }); // fetch admin (sin increment)
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products/1?admin=1").set("Authorization", authHeader);

    const args = findManyMock.mock.calls[0][0];
    expect(args.where.visibleEnCatalogo).toBeUndefined();
  });
});
