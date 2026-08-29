import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

// La vista admin la habilita el JWT verificado, no `?admin=1` (ver
// products.routes.autorizacion.test.js).
const authHeader = `Bearer ${jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" })}`;

const findManyMock = vi.fn();
const findUniqueMock = vi.fn();
const updateMock = vi.fn();
const countMock = vi.fn();

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

/**
 * Fila tal como la devuelve Prisma con `LIST_SELECT`: sin las tres columnas
 * `NVarChar(Max)`, sin relaciones de contenido y con una sola foto.
 */
const filaListado = {
  id: 42,
  sku: "YIMA-BRUMAF-1234",
  nombre: "Bruma Facial",
  precio: "100",
  etiqueta: "Nuevo",
  visibleEnCatalogo: true,
  stock: 10,
  destacado: true,
  vistas: 7,
  compartidos: 2,
  categoria: { id: 5, nombre: "Cuidado" },
  fotos: [{ id: 900, url: "https://cdn/foto.jpg", orden: 0, cloudinaryPublicId: "p/1", driveFileId: null }],
  _count: { fotos: 4 },
};

beforeEach(() => {
  findManyMock.mockReset();
  findUniqueMock.mockReset();
  updateMock.mockReset();
  countMock.mockReset();
  countMock.mockResolvedValue(0);
});

describe("GET /api/products - payload liviano de listado", () => {
  it("consulta con select liviano (no include) y una sola foto", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products");

    const args = findManyMock.mock.calls[0][0];
    expect(args.include).toBeUndefined();
    expect(args.select).toBeDefined();
    expect(args.select.fotos.take).toBe(1);
    expect(args.select.fotos.orderBy).toEqual({ orden: "asc" });
  });

  it("no pide las tres columnas NVarChar(Max) ni las relaciones de contenido", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products");

    const { select } = findManyMock.mock.calls[0][0];
    for (const campo of [
      "descripcion",
      "porQueLoVasAQuerer",
      "tePasaEsto",
      "caracteristicas",
      "listas",
      "especificaciones",
      "video",
      "fraseComercial",
    ]) {
      expect(select[campo]).toBeUndefined();
    }
  });

  it("devuelve exactamente los campos que consumen la grilla y el admin", async () => {
    findManyMock.mockResolvedValue([filaListado]);

    const res = await request(buildApp()).get("/api/products");

    expect(res.status).toBe(200);
    const [producto] = res.body.data ?? res.body;
    expect(Object.keys(producto).sort()).toEqual(
      [
        "cantidadFotos",
        "categoria",
        "compartidos",
        "destacado",
        "etiqueta",
        "fotos",
        "id",
        "nombre",
        "precio",
        "sku",
        "stock",
        "visibleEnCatalogo",
        "vistas",
      ].sort(),
    );
    expect(producto.precio).toBe("100");
    expect(producto.categoria).toEqual({ id: 5, nombre: "Cuidado" });
    expect(producto.fotos).toEqual([{ id: 900, url: "https://cdn/foto.jpg", orden: 0 }]);
    expect(producto.cantidadFotos).toBe(4);
  });

  it("mantiene el proxy de fotos legado de Drive en el listado", async () => {
    findManyMock.mockResolvedValue([
      {
        ...filaListado,
        fotos: [{ id: 901, url: "https://drive/x", orden: 0, cloudinaryPublicId: null, driveFileId: "drive-1" }],
      },
    ]);

    const res = await request(buildApp()).get("/api/products");

    const [producto] = res.body.data ?? res.body;
    expect(producto.fotos[0].url).toBe("/api/products/42/fotos/901");
  });

  it("los relacionados del detalle usan el mismo select liviano", async () => {
    const principal = {
      id: 1,
      nombre: "Principal",
      sku: "SKU-1",
      descripcion: "d",
      precio: "10",
      etiqueta: null,
      categoriaId: 5,
      categoria: null,
      caracteristicas: [],
      listas: [],
      especificaciones: [],
      fotos: [],
      video: null,
      vistas: 0,
      compartidos: 0,
      favoritosCount: 0,
      visibleEnCatalogo: true,
      stock: 1,
      destacado: false,
      fraseComercial: null,
      porQueLoVasAQuerer: null,
      tePasaEsto: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    findUniqueMock.mockResolvedValueOnce(principal);
    updateMock.mockResolvedValue({ ...principal, vistas: 1 });
    findManyMock.mockResolvedValue([filaListado]);

    const res = await request(buildApp()).get("/api/products/1");

    const args = findManyMock.mock.calls[0][0];
    expect(args.include).toBeUndefined();
    expect(args.select.fotos.take).toBe(1);
    expect(res.body.relacionados[0].descripcion).toBeUndefined();
    expect(res.body.relacionados[0].nombre).toBe("Bruma Facial");
  });

  it("el detalle sigue devolviendo el producto completo", async () => {
    const completo = {
      id: 1,
      nombre: "Principal",
      sku: "SKU-1",
      descripcion: "Descripción larga",
      precio: "10",
      etiqueta: null,
      categoriaId: null,
      categoria: null,
      caracteristicas: [],
      listas: [],
      especificaciones: [],
      fotos: [],
      video: null,
      vistas: 0,
      compartidos: 0,
      favoritosCount: 0,
      visibleEnCatalogo: true,
      stock: 1,
      destacado: false,
      fraseComercial: null,
      porQueLoVasAQuerer: null,
      tePasaEsto: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    findUniqueMock.mockResolvedValueOnce(completo);
    updateMock.mockResolvedValue({ ...completo, vistas: 1 });

    const res = await request(buildApp()).get("/api/products/1");

    expect(res.body.descripcion).toBe("Descripción larga");
    expect(res.body.especificaciones).toEqual([]);
    expect(res.body.cantidadFotos).toBe(0);
  });
});

describe("GET /api/products - parámetro ids", () => {
  it("filtra por la lista exacta de ids", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?ids=1,7,12");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.id).toEqual({ in: [1, 7, 12] });
  });

  it("compone ids con las guardas públicas (visibilidad y stock)", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?ids=1,7");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 }, id: { in: [1, 7] } });
  });

  it("compone ids con el resto de los filtros", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?ids=1,7&categoria=3");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.id).toEqual({ in: [1, 7] });
    expect(where.categoriaId).toBe(3);
  });

  it("en modo admin (autenticado) no aplica las guardas públicas", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?ids=1,7&admin=1").set("Authorization", authHeader);

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ id: { in: [1, 7] } });
  });

  it("descarta ids no numéricos y deduplica conservando el orden", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?ids=7,abc,7,,1,-3,2.5");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.id).toEqual({ in: [7, 1] });
  });

  it("ids vacío devuelve lista vacía SIN consultar la base (no el catálogo entero)", async () => {
    const res = await request(buildApp()).get("/api/products?ids=");

    expect(res.status).toBe(200);
    expect(res.body.data ?? res.body).toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("ids sin ningún valor válido devuelve lista vacía sin consultar la base", async () => {
    const res = await request(buildApp()).get("/api/products?ids=abc,,xyz");

    expect(res.status).toBe(200);
    expect(res.body.data ?? res.body).toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("rechaza con 400 una lista de ids más larga que el tope, sin truncar en silencio", async () => {
    const demasiados = Array.from({ length: 101 }, (_, i) => i + 1).join(",");

    const res = await request(buildApp()).get(`/api/products?ids=${demasiados}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/100/);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("acepta exactamente el tope de ids", async () => {
    findManyMock.mockResolvedValue([]);
    const justos = Array.from({ length: 100 }, (_, i) => i + 1).join(",");

    const res = await request(buildApp()).get(`/api/products?ids=${justos}`);

    expect(res.status).toBe(200);
    expect(findManyMock.mock.calls[0][0].where.id.in).toHaveLength(100);
  });
});

describe("GET /api/products - paginacion", () => {
  it("devuelve el sobre { data, page, pageSize, total }", async () => {
    findManyMock.mockResolvedValue([filaListado]);
    countMock.mockResolvedValue(37);

    const res = await request(buildApp()).get("/api/products");

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["data", "page", "pageSize", "total"]);
    expect(res.body.total).toBe(37);
    expect(res.body.data).toHaveLength(1);
  });

  it("usa 12 por pagina por defecto (cadencia de la grilla)", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/products");

    expect(res.body.pageSize).toBe(12);
    const args = findManyMock.mock.calls[0][0];
    expect(args.skip).toBe(0);
    expect(args.take).toBe(12);
  });

  it("aplica skip/take segun page y pageSize", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/products?page=3&pageSize=10");

    expect(res.body.page).toBe(3);
    expect(res.body.pageSize).toBe(10);
    const args = findManyMock.mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(10);
  });

  it("clampea pageSize al tope compartido y cae al default con basura", async () => {
    findManyMock.mockResolvedValue([]);

    const topeado = await request(buildApp()).get("/api/products?pageSize=99999");
    expect(topeado.body.pageSize).toBe(100);

    findManyMock.mockClear();
    const basura = await request(buildApp()).get("/api/products?page=abc&pageSize=-4");
    expect(basura.body.page).toBe(1);
    expect(basura.body.pageSize).toBe(12);
  });

  it("cuenta el total con el MISMO where que el listado", async () => {
    findManyMock.mockResolvedValue([]);
    countMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/products?categoria=3");

    expect(countMock.mock.calls[0][0].where).toEqual(findManyMock.mock.calls[0][0].where);
  });

  it("ids saltea la paginacion: devuelve todo lo pedido en una sola pagina", async () => {
    findManyMock.mockResolvedValue([filaListado, { ...filaListado, id: 43 }]);

    const res = await request(buildApp()).get("/api/products?ids=42,43&page=5&pageSize=1");

    expect(res.body.data).toHaveLength(2);
    expect(res.body.page).toBe(1);
    expect(res.body.total).toBe(2);
    const args = findManyMock.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
    expect(args.take).toBeUndefined();
    expect(countMock).not.toHaveBeenCalled();
  });

  it("ids vacio devuelve el sobre vacio, no el catalogo", async () => {
    const res = await request(buildApp()).get("/api/products?ids=");

    expect(res.body).toEqual({ data: [], page: 1, pageSize: 100, total: 0 });
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/products - filtro destacado y orden", () => {
  it("destacado=1 filtra por destacado true", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?destacado=1");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.destacado).toBe(true);
  });

  it("sin destacado no agrega el filtro", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where.destacado).toBeUndefined();
  });

  it("orden por defecto: `recientes` (más nuevos primero)", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products");

    expect(findManyMock.mock.calls[0][0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("orden=vistas ordena por vistas descendente", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?orden=vistas");

    expect(findManyMock.mock.calls[0][0].orderBy).toEqual([{ vistas: "desc" }, { id: "asc" }]);
  });

  it("orden desconocido cae al default sin romper", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/products?orden=loquesea");

    expect(res.status).toBe(200);
    expect(findManyMock.mock.calls[0][0].orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });
});
