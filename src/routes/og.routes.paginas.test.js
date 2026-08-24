import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const productFindManyMock = vi.fn();
const categoriaFindManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: { findMany: (...a) => productFindManyMock(...a), findUnique: vi.fn() },
    // `findMany` y no `findFirst`: el slug NO es reversible (las tildes y los
    // símbolos se pierden al slugificar), así que no se puede buscar por
    // nombre. Se traen todas las categorías —son pocas decenas— y se compara
    // el slug derivado de cada una.
    categoria: { findMany: (...a) => categoriaFindManyMock(...a) },
  },
}));

const { default: ogRouter } = await import("./og.routes.js");

function buildApp() {
  const app = express();
  app.use("/og", ogRouter);
  return app;
}

const UA_BOT = "Mozilla/5.0 (compatible; Googlebot/2.1)";

beforeEach(() => {
  productFindManyMock.mockReset().mockResolvedValue([
    { id: 1, nombre: "Set de cuchillos", precio: { toString: () => "45000.00" } },
  ]);
  categoriaFindManyMock.mockReset().mockResolvedValue([]);
  process.env.FRONTEND_URL = "https://yima.example.com";
  process.env.BACKEND_PUBLIC_URL = "https://api.yima.example.com";
});

describe("GET /og/home", () => {
  it("responde 200 con Organization y canoniza a la raíz", async () => {
    const res = await request(buildApp()).get("/og/home").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.text).toContain('<link rel="canonical" href="https://yima.example.com/" />');
    expect(res.text).toContain('"@type":"Organization"');
    expect(res.text).not.toContain("noindex");
  });

  it("emite el MISMO <h1> y el mismo copy que la home real, no un resumen (regla de cloaking)", async () => {
    const res = await request(buildApp()).get("/og/home").set("User-Agent", UA_BOT);

    // Mismo texto que `frontend/src/pages/Catalogo.jsx` y
    // `frontend/src/constants/hero.js` — antes de este fix el cuerpo emitía
    // `<h1>YIMA</h1>`, un h1 que la persona nunca ve.
    expect(res.text).toContain("<h1>Descubrí cosas que te hacen la vida más fácil.</h1>");
    expect(res.text).toContain(
      "En YIMA reunimos productos útiles, innovadores y con diseño que simplifican tu rutina",
    );
    expect(res.text).toContain("Productos seleccionados");
    expect(res.text).toContain("El Manifiesto YIMA");
    expect(res.text).toContain("elegimos piezas que valen la pena tener cerca");
    // Grafo interno: un link a la colección, aunque no haya destacados.
    expect(res.text).toContain('href="https://yima.example.com/coleccion"');
  });

  it("oculta la sección de destacados por debajo de MIN_DESTACADOS, igual que el carrusel real", async () => {
    // El mock por defecto de este archivo devuelve un solo producto.
    const res = await request(buildApp()).get("/og/home").set("User-Agent", UA_BOT);

    expect(res.text).not.toContain("Hallazgos del día");
    expect(res.text).not.toContain("Set de cuchillos");
  });

  it("lista los destacados con sus links cuando hay 4 o más", async () => {
    productFindManyMock.mockResolvedValue([
      { id: 1, nombre: "Set de cuchillos", precio: { toString: () => "45000.00" } },
      { id: 2, nombre: "Tabla de madera", precio: { toString: () => "12000.00" } },
      { id: 3, nombre: "Organizador", precio: { toString: () => "8000.00" } },
      { id: 4, nombre: "Lámpara", precio: { toString: () => "20000.00" } },
    ]);

    const res = await request(buildApp()).get("/og/home").set("User-Agent", UA_BOT);

    expect(res.text).toContain("Hallazgos del día");
    expect(res.text).toContain("/producto/1-set-de-cuchillos");
    expect(res.text).toContain("/producto/4-lampara");

    const [args] = productFindManyMock.mock.calls[0];
    expect(args.where).toMatchObject({ destacado: true, visibleEnCatalogo: true, stock: { gt: 0 } });
  });
});

describe("GET /og/coleccion", () => {
  it("responde 200 con CollectionPage y lista los productos", async () => {
    const res = await request(buildApp()).get("/og/coleccion").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.text).toContain('href="https://yima.example.com/coleccion"');
    expect(res.text).toContain('"@type":"CollectionPage"');
    expect(res.text).toContain("Set de cuchillos");
    expect(res.text).toContain("/producto/1-set-de-cuchillos");
  });
});

describe("GET /og/categoria/:slug", () => {
  it("responde 200 con el nombre de la categoría cuando el slug matchea alguna", async () => {
    categoriaFindManyMock.mockResolvedValue([{ id: 3, nombre: "Cocina y hogar" }]);

    const res = await request(buildApp()).get("/og/categoria/cocina-y-hogar").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.text).toContain("<title>Cocina y hogar — YIMA</title>");
    expect(res.text).toContain('href="https://yima.example.com/coleccion/categoria/cocina-y-hogar"');
    expect(res.text).toContain("<h1>Cocina y hogar</h1>");
  });

  it("responde 404 + noindex cuando ningún slug de categoría matchea", async () => {
    categoriaFindManyMock.mockResolvedValue([{ id: 3, nombre: "Cocina y hogar" }]);

    const res = await request(buildApp()).get("/og/categoria/no-existe").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(res.text).toContain('content="noindex, follow"');
  });

  it("matchea la categoría por el slug DERIVADO, no por el nombre crudo", async () => {
    // "Baño & Cocina" -> "bano-cocina". El slug no es reversible, así que la
    // única forma de resolverlo es slugificar cada categoría y comparar.
    categoriaFindManyMock.mockResolvedValue([{ id: 8, nombre: "Baño & Cocina" }]);

    const res = await request(buildApp()).get("/og/categoria/bano-cocina").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.text).toContain("Baño &amp; Cocina");
  });

  it("filtra los productos por la categoría encontrada", async () => {
    categoriaFindManyMock.mockResolvedValue([{ id: 3, nombre: "Cocina" }]);

    await request(buildApp()).get("/og/categoria/cocina").set("User-Agent", UA_BOT);

    const [args] = productFindManyMock.mock.calls[0];
    expect(args.where).toMatchObject({ visibleEnCatalogo: true, categoriaId: 3 });
  });
});

describe("navegador en las rutas de página", () => {
  it("redirige 302 a la SPA", async () => {
    const res = await request(buildApp()).get("/og/coleccion").set("User-Agent", "Mozilla/5.0 Chrome/120");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://yima.example.com/coleccion");
  });
});
