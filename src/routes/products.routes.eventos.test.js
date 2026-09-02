import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

// El camino admin (sin contar la vista ni emitir el evento) lo habilita el JWT
// verificado, no `?admin=1` (ver products.routes.autorizacion.test.js).
const authHeader = `Bearer ${jwt.sign({ sub: 1, tokenVersion: 0 }, "test-secret", { expiresIn: "7d" })}`;

const findUniqueMock = vi.fn();
const updateMock = vi.fn();
const findManyMock = vi.fn();
const eventoCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findUnique: (...args) => findUniqueMock(...args),
      update: (...args) => updateMock(...args),
      findMany: (...args) => findManyMock(...args),
    },
    eventoTrafico: { create: (...args) => eventoCreateMock(...args) },
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

const productoBase = {
  id: 42,
  nombre: "Bruma Facial",
  sku: "YIMA-BRUMAF-1234",
  descripcion: "Una bruma",
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

/**
 * Los eventos se emiten fire-and-forget (sin await), así que la respuesta HTTP
 * puede llegar antes de que el insert se haya encolado. Se cede el event loop
 * una vez para dejar que el microtask del emisor corra antes de assertear.
 */
async function esperarEmision() {
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  eventoCreateMock.mockResolvedValue({ id: 1 });
  findManyMock.mockResolvedValue([]);
});

describe("GET /api/products/:id — evento VISTA_PRODUCTO", () => {
  it("emite VISTA_PRODUCTO con el productId en el camino público", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue({ ...productoBase, vistas: 1 });

    const res = await request(buildApp()).get("/api/products/42");
    await esperarEmision();

    expect(res.status).toBe(200);
    expect(eventoCreateMock).toHaveBeenCalledTimes(1);
    expect(eventoCreateMock.mock.calls[0][0].data).toMatchObject({
      tipo: "VISTA_PRODUCTO",
      productId: 42,
    });
  });

  it("captura referrer y userAgent de los headers del request", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue({ ...productoBase, vistas: 1 });

    await request(buildApp())
      .get("/api/products/42")
      .set("Referer", "https://yima.example.com/coleccion")
      .set("User-Agent", "Mozilla/5.0");
    await esperarEmision();

    expect(eventoCreateMock.mock.calls[0][0].data).toMatchObject({
      referrer: "https://yima.example.com/coleccion",
      userAgent: "Mozilla/5.0",
    });
  });

  it("NO emite evento en el camino admin (autenticado), igual que el contador de vistas", async () => {
    findUniqueMock.mockResolvedValue(productoBase);

    const res = await request(buildApp())
      .get("/api/products/42?admin=1")
      .set("Authorization", authHeader);
    await esperarEmision();

    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
    expect(eventoCreateMock).not.toHaveBeenCalled();
  });

  it("SÍ emite evento con ?admin=1 pero sin token: un anónimo no puede evadir el registro", async () => {
    // El parámetro ya no habilita el camino admin. Si lo hiciera, cualquiera
    // podría navegar el catálogo sin quedar registrado en analytics.
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue({ ...productoBase, vistas: 1 });

    const res = await request(buildApp()).get("/api/products/42?admin=1");
    await esperarEmision();

    expect(res.status).toBe(200);
    expect(eventoCreateMock).toHaveBeenCalled();
  });

  it("no emite evento si el producto no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/products/42");
    await esperarEmision();

    expect(res.status).toBe(404);
    expect(eventoCreateMock).not.toHaveBeenCalled();
  });

  it("responde 200 igual si el insert del evento falla (best-effort)", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue({ ...productoBase, vistas: 1 });
    eventoCreateMock.mockRejectedValue(new Error("DB caída"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(buildApp()).get("/api/products/42");
    await esperarEmision();

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(42);
    spy.mockRestore();
  });

  it("mantiene el incremento del contador vistas (el evento es aditivo)", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue({ ...productoBase, vistas: 1 });

    await request(buildApp()).get("/api/products/42");

    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { vistas: { increment: 1 } } }),
    );
  });
});

describe("POST /api/products/:id/compartir — evento COMPARTIDO", () => {
  it("emite COMPARTIDO con el productId", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue(productoBase);

    const res = await request(buildApp()).post("/api/products/42/compartir");
    await esperarEmision();

    expect(res.status).toBe(200);
    expect(eventoCreateMock).toHaveBeenCalledTimes(1);
    expect(eventoCreateMock.mock.calls[0][0].data).toMatchObject({
      tipo: "COMPARTIDO",
      productId: 42,
    });
  });

  it("captura referrer y userAgent", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue(productoBase);

    await request(buildApp())
      .post("/api/products/42/compartir")
      .set("Referer", "https://yima.example.com/producto/42")
      .set("User-Agent", "Mozilla/5.0");
    await esperarEmision();

    expect(eventoCreateMock.mock.calls[0][0].data).toMatchObject({
      referrer: "https://yima.example.com/producto/42",
      userAgent: "Mozilla/5.0",
    });
  });

  it("responde 200 igual si el insert del evento falla (best-effort)", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue(productoBase);
    eventoCreateMock.mockRejectedValue(new Error("DB caída"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(buildApp()).post("/api/products/42/compartir");
    await esperarEmision();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    spy.mockRestore();
  });

  it("mantiene el incremento del contador compartidos (el evento es aditivo)", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue(productoBase);

    await request(buildApp()).post("/api/products/42/compartir");

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { compartidos: { increment: 1 } },
    });
  });

  it("no emite evento si el producto no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).post("/api/products/42/compartir");
    await esperarEmision();

    expect(res.status).toBe(404);
    expect(eventoCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/products/:id/favorito — evento FAVORITO_AGREGADO", () => {
  it("emite FAVORITO_AGREGADO con el productId", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue(productoBase);

    const res = await request(buildApp()).post("/api/products/42/favorito");
    await esperarEmision();

    expect(res.status).toBe(200);
    expect(eventoCreateMock).toHaveBeenCalledTimes(1);
    expect(eventoCreateMock.mock.calls[0][0].data).toMatchObject({
      tipo: "FAVORITO_AGREGADO",
      productId: 42,
    });
  });

  it("captura referrer y userAgent", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue(productoBase);

    await request(buildApp())
      .post("/api/products/42/favorito")
      .set("Referer", "https://yima.example.com/producto/42")
      .set("User-Agent", "Mozilla/5.0");
    await esperarEmision();

    expect(eventoCreateMock.mock.calls[0][0].data).toMatchObject({
      referrer: "https://yima.example.com/producto/42",
      userAgent: "Mozilla/5.0",
    });
  });

  it("responde 200 igual si el insert del evento falla (best-effort)", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue(productoBase);
    eventoCreateMock.mockRejectedValue(new Error("DB caída"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(buildApp()).post("/api/products/42/favorito");
    await esperarEmision();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    spy.mockRestore();
  });

  it("mantiene el incremento del contador favoritosCount (el evento es aditivo)", async () => {
    findUniqueMock.mockResolvedValue(productoBase);
    updateMock.mockResolvedValue(productoBase);

    await request(buildApp()).post("/api/products/42/favorito");

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { favoritosCount: { increment: 1 } },
    });
  });

  it("no emite evento si el producto no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).post("/api/products/42/favorito");
    await esperarEmision();

    expect(res.status).toBe(404);
    expect(eventoCreateMock).not.toHaveBeenCalled();
  });
});

describe("rate limit de las interacciones públicas de producto", () => {
  // `POST /:id/compartir` y `POST /:id/favorito` son públicos, sin auth, y
  // además de insertar una fila en `EventoTrafico` incrementan contadores en
  // `Product` (`compartidos` / `favoritosCount`). Sin limitador cualquiera
  // puede inflar esas métricas a voluntad.
  //
  // Igual que en eventos, acá se verifica el CABLEADO (headers `RateLimit-*`)
  // y que un uso humano normal no se bloquee; el 429 en sí ya está cubierto
  // por `middlewares/rateLimit.middleware.test.js`.
  it("expone los headers RateLimit-* en POST /:id/compartir", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase });
    updateMock.mockResolvedValue({ ...productoBase, compartidos: 1 });

    const res = await request(buildApp()).post("/api/products/42/compartir");

    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe("100");
  });

  it("expone los headers RateLimit-* en POST /:id/favorito", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase });
    updateMock.mockResolvedValue({ ...productoBase, favoritosCount: 1 });

    const res = await request(buildApp()).post("/api/products/42/favorito");

    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe("100");
  });

  it("no bloquea a alguien marcando 20 favoritos seguidos", async () => {
    findUniqueMock.mockResolvedValue({ ...productoBase });
    updateMock.mockResolvedValue({ ...productoBase, favoritosCount: 1 });
    const app = buildApp();

    for (let i = 0; i < 20; i++) {
      const res = await request(app).post("/api/products/42/favorito");
      expect(res.status).toBe(200);
    }
  });
});
