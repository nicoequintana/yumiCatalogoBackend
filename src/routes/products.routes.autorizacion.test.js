import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * El modo admin de los dos endpoints públicos de producto (`GET /products` y
 * `GET /products/:id`) sale del JWT verificado, NUNCA de `?admin=1`.
 *
 * Antes bastaba con agregar `?admin=1` a la URL — un parámetro que además está
 * escrito en el bundle público (`frontend/src/api/products.js`), o sea
 * descubrible leyendo el JS, no adivinable — para que un llamador anónimo
 * viera productos ocultos (`visibleEnCatalogo: false`) y agotados. Este archivo
 * fija el comportamiento correcto: el parámetro no otorga nada, el token sí.
 */

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
vi.mock("../services/cloudinary.service.js", () => ({}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

function tokenValido() {
  return jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", { expiresIn: "7d" });
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
  listas: [],
  especificaciones: [],
  fotos: [],
  video: null,
  vistas: 0,
  compartidos: 0,
  favoritosCount: 0,
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
  countMock.mockReset().mockResolvedValue(0);
});

describe("GET /api/products — el modo admin depende del token, no de ?admin=1", () => {
  it("?admin=1 SIN token aplica igual las guardas públicas de visibilidad y stock", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/products?admin=1");

    expect(res.status).toBe(200);
    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 } });
  });

  it("?admin=1 CON token válido levanta las guardas y trae ocultos y agotados", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/products?admin=1")
      .set("Authorization", `Bearer ${tokenValido()}`);

    expect(res.status).toBe(200);
    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toBeUndefined();
  });

  it("un token válido alcanza aunque no venga ?admin=1: el parámetro no es la llave", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products").set("Authorization", `Bearer ${tokenValido()}`);

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toBeUndefined();
  });

  it("un token basura NO da 401 en este endpoint público: degrada a anónimo con las guardas puestas", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/products?admin=1")
      .set("Authorization", "Bearer token-basura");

    expect(res.status).toBe(200);
    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 } });
  });

  it("un token expirado degrada a anónimo igual que uno basura", async () => {
    findManyMock.mockResolvedValue([]);
    const expirado = jwt.sign({ sub: 1, tokenVersion: 0 }, "test-secret", { expiresIn: -10 });

    const res = await request(buildApp())
      .get("/api/products?admin=1")
      .set("Authorization", `Bearer ${expirado}`);

    expect(res.status).toBe(200);
    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 } });
  });

  it("un token firmado con otro secreto no otorga nada", async () => {
    findManyMock.mockResolvedValue([]);
    const ajeno = jwt.sign({ sub: 1, tokenVersion: 0 }, "otro-secreto", { expiresIn: "7d" });

    await request(buildApp()).get("/api/products?admin=1").set("Authorization", `Bearer ${ajeno}`);

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 } });
  });

  it("pedir por ?ids= con ?admin=1 y sin token tampoco saltea las guardas públicas", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?ids=1,7&admin=1");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ visibleEnCatalogo: true, stock: { gt: 0 }, id: { in: [1, 7] } });
  });
});

describe("GET /api/products/:id — el 404 de producto oculto solo lo levanta el token", () => {
  it("?admin=1 sin token sobre un producto oculto sigue devolviendo 404", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase, visibleEnCatalogo: false });

    const res = await request(buildApp()).get("/api/products/42?admin=1");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Producto no encontrado." });
  });

  it("un token basura sobre un producto oculto sigue devolviendo 404", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase, visibleEnCatalogo: false });

    const res = await request(buildApp())
      .get("/api/products/42?admin=1")
      .set("Authorization", "Bearer token-basura");

    expect(res.status).toBe(404);
  });

  it("con token válido devuelve el producto oculto", async () => {
    const oculto = { ...productoBase, visibleEnCatalogo: false };
    findUniqueMock.mockResolvedValue(oculto);

    const res = await request(buildApp())
      .get("/api/products/42?admin=1")
      .set("Authorization", `Bearer ${tokenValido()}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
  });

  it("con token válido no incrementa el contador de vistas", async () => {
    findUniqueMock.mockResolvedValue(productoBase);

    const res = await request(buildApp())
      .get("/api/products/42?admin=1")
      .set("Authorization", `Bearer ${tokenValido()}`);

    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("un admin autenticado no infla vistas aunque no mande ?admin=1", async () => {
    findUniqueMock.mockResolvedValue(productoBase);

    const res = await request(buildApp())
      .get("/api/products/42")
      .set("Authorization", `Bearer ${tokenValido()}`);

    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("?admin=1 SIN token sí cuenta la vista: un anónimo no puede evadir el contador", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue({ ...productoBase, vistas: 1 });

    const res = await request(buildApp()).get("/api/products/42?admin=1");

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { vistas: { increment: 1 } } }),
    );
  });

  it("los relacionados solo dejan de filtrar por visibilidad con token válido", async () => {
    const principal = { ...productoBase, id: 1, categoriaId: 5 };
    findUniqueMock.mockResolvedValue(principal);
    updateMock.mockResolvedValue({ ...principal, vistas: 1 });
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products/1?admin=1");

    expect(findManyMock.mock.calls[0][0].where.visibleEnCatalogo).toBe(true);
  });
});

describe("POST compartir/favorito — un producto oculto es indistinguible de uno inexistente", () => {
  // Los dos endpoints son públicos y los ids son secuenciales: si un producto
  // oculto respondiera `{ ok: true }` mientras uno inexistente da 404,
  // cualquiera podría enumerar los ocultos probando enteros — el mismo agujero
  // que `obtenerPorId` y los proxies de media ya cierran. Además, sin la
  // guarda, un anónimo puede inflar `compartidos`/`favoritosCount` de
  // productos que el admin sacó del catálogo a propósito.

  it("compartir un producto oculto sin token devuelve el MISMO 404 que un id inexistente y no toca el contador", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase, visibleEnCatalogo: false });

    const res = await request(buildApp()).post("/api/products/42/compartir");

    findUniqueMock.mockResolvedValue(null);
    const resInexistente = await request(buildApp()).post("/api/products/999/compartir");

    expect(res.status).toBe(404);
    expect(res.body).toEqual(resInexistente.body);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("favorito sobre un producto oculto sin token devuelve el MISMO 404 que un id inexistente y no toca el contador", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase, visibleEnCatalogo: false });

    const res = await request(buildApp()).post("/api/products/42/favorito");

    findUniqueMock.mockResolvedValue(null);
    const resInexistente = await request(buildApp()).post("/api/products/999/favorito");

    expect(res.status).toBe(404);
    expect(res.body).toEqual(resInexistente.body);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("un admin autenticado sí puede compartir un producto oculto", async () => {
    const oculto = { ...productoBase, visibleEnCatalogo: false };
    findUniqueMock.mockResolvedValue(oculto);
    updateMock.mockResolvedValue(oculto);

    const res = await request(buildApp())
      .post("/api/products/42/compartir")
      .set("Authorization", `Bearer ${tokenValido()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { compartidos: { increment: 1 } },
    });
  });

  it("un admin autenticado sí puede marcar favorito un producto oculto", async () => {
    const oculto = { ...productoBase, visibleEnCatalogo: false };
    findUniqueMock.mockResolvedValue(oculto);
    updateMock.mockResolvedValue(oculto);

    const res = await request(buildApp())
      .post("/api/products/42/favorito")
      .set("Authorization", `Bearer ${tokenValido()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { favoritosCount: { increment: 1 } },
    });
  });

  it("un anónimo sobre un producto visible sigue funcionando (compartir y favorito)", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue(productoBase);

    const compartir = await request(buildApp()).post("/api/products/42/compartir");
    const favorito = await request(buildApp()).post("/api/products/42/favorito");

    expect(compartir.status).toBe(200);
    expect(compartir.body).toEqual({ ok: true });
    expect(favorito.status).toBe(200);
    expect(favorito.body).toEqual({ ok: true });
  });

  it("un producto agotado pero visible sigue siendo compartible: el stock NO entra en la guarda", async () => {
    // La ficha de un agotado devuelve 200 justamente para que un link
    // compartido no se rompa — compartirlo tiene que seguir funcionando igual.
    const agotado = { ...productoBase, stock: 0 };
    findUniqueMock.mockResolvedValue(agotado);
    updateMock.mockResolvedValue(agotado);

    const res = await request(buildApp()).post("/api/products/42/compartir");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
