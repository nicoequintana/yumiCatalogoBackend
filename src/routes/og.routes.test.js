import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const findUniqueMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { product: { findUnique: (...args) => findUniqueMock(...args) } },
}));

const { default: ogRouter } = await import("./og.routes.js");

function buildApp() {
  const app = express();
  app.use("/og", ogRouter);
  return app;
}

function productoCompleto(extra = {}) {
  return {
    id: 5,
    nombre: "Set de cuchillos",
    descripcion: "Seis piezas de acero inoxidable con mango ergonómico.",
    sku: "YIMA-0005",
    etiqueta: "Nuevo",
    precio: { toString: () => "45000.00" },
    stock: 4,
    visibleEnCatalogo: true,
    fraseComercial: "La cocina que siempre quisiste.",
    porQueLoVasAQuerer: "Cortan parejo y no se oxidan.",
    tePasaEsto: "Se te resbala el cuchillo al cortar.",
    categoria: { id: 3, nombre: "Cocina" },
    caracteristicas: [{ id: 1, texto: "Acero inoxidable" }],
    listas: [
      { id: 1, tipo: "BENEFICIO", texto: "Filo duradero", orden: 0 },
      { id: 2, tipo: "USO", texto: "Cortar verduras", orden: 0 },
      { id: 3, tipo: "IDEAL_PARA", texto: "Cocinar en casa", orden: 0 },
      { id: 4, tipo: "INCLUYE", texto: "Taco de madera", orden: 0 },
    ],
    especificaciones: [{ id: 1, nombre: "Material", valor: "Acero", orden: 0 }],
    fotos: [{ id: 1, orden: 0, url: "https://res.cloudinary.com/demo/a.jpg", cloudinaryPublicId: "a", driveFileId: null }],
    video: null,
    ...extra,
  };
}

const UA_BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const UA_NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0";

beforeEach(() => {
  findUniqueMock.mockReset();
  process.env.FRONTEND_URL = "https://yima.example.com";
  process.env.BACKEND_PUBLIC_URL = "https://api.yima.example.com";
});

describe("GET /og/producto/:idSlug — producto visible", () => {
  it("responde 200 con el título del producto y el canonical con slug", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5-set-de-cuchillos").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("<title>Set de cuchillos — YIMA</title>");
    expect(res.text).toContain('<link rel="canonical" href="https://yima.example.com/producto/5-set-de-cuchillos" />');
    expect(res.text).not.toContain("noindex");
  });

  it("acepta el id pelado, sin slug, y canoniza igual a la URL con slug", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.text).toContain('href="https://yima.example.com/producto/5-set-de-cuchillos"');
  });

  it("usa la frase comercial como description, no la descripción larga", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.text).toContain('name="description" content="La cocina que siempre quisiste."');
  });

  it("cae a la descripción truncada cuando no hay frase comercial", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto({ fraseComercial: null }));

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.text).toContain("Seis piezas de acero inoxidable");
  });

  it("emite el cuerpo con TODO el contenido de la ficha (regla de cloaking)", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.text).toContain("<h1>Set de cuchillos</h1>");
    expect(res.text).toContain("Seis piezas de acero inoxidable");
    expect(res.text).toContain("Cortan parejo y no se oxidan");
    expect(res.text).toContain("Se te resbala el cuchillo al cortar");
    expect(res.text).toContain("Filo duradero");
    expect(res.text).toContain("Cortar verduras");
    expect(res.text).toContain("Cocinar en casa");
    expect(res.text).toContain("Taco de madera");
    expect(res.text).toContain("Acero inoxidable");
    expect(res.text).toContain("Material");
    expect(res.text).toContain("Etiqueta: Nuevo");
  });

  it("emite los bloques JSON-LD de Product y BreadcrumbList", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    const bloques = [...res.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]));

    expect(bloques).toHaveLength(2);
    expect(bloques[0]["@type"]).toBe("Product");
    expect(bloques[0].offers.price).toBe("45000.00");
    expect(bloques[0].offers.availability).toBe("https://schema.org/InStock");
    expect(bloques[1]["@type"]).toBe("BreadcrumbList");
  });

  it("consulta la base con PRODUCT_INCLUDE, no solo con las fotos", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    const [args] = findUniqueMock.mock.calls[0];
    expect(args.where).toEqual({ id: 5 });
    expect(args.include).toHaveProperty("especificaciones");
    expect(args.include).toHaveProperty("listas");
    expect(args.include).toHaveProperty("caracteristicas");
  });
});

describe("GET /og/producto/:idSlug — producto agotado", () => {
  it("responde 200 e indexa, con availability OutOfStock", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto({ stock: 0 }));

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    // Agotado es un estado comercial: el detalle público devuelve 200 a
    // propósito para que un link compartido no se rompa.
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("noindex");
    expect(res.text).toContain("https://schema.org/OutOfStock");
  });
});

describe("GET /og/producto/:idSlug — 404 reales", () => {
  it("responde 404 + noindex cuando el producto está oculto", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto({ visibleEnCatalogo: false }));

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(res.text).toContain('content="noindex, follow"');
    expect(res.text).not.toContain("Set de cuchillos");
  });

  it("responde 404 + noindex cuando el producto no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/og/producto/999").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(res.text).toContain('content="noindex, follow"');
  });

  it("responde 404 sin tocar la base cuando el id no es numérico", async () => {
    const res = await request(buildApp()).get("/og/producto/set-de-cuchillos").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("responde 404 sin tocar la base cuando el id es un decimal", async () => {
    const res = await request(buildApp()).get("/og/producto/12.5").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

describe("GET /og/producto/:idSlug — navegador", () => {
  it("redirige 302 a la SPA con la URL canónica cuando el UA no es bot", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_NAVEGADOR);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://yima.example.com/producto/5-set-de-cuchillos");
  });

  it("redirige a la home cuando el id no resuelve un producto", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/og/producto/999").set("User-Agent", UA_NAVEGADOR);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://yima.example.com/");
  });
});

describe("GET /og/producto/:idSlug — escape", () => {
  it("no deja que un nombre con </script> cierre el bloque JSON-LD", async () => {
    findUniqueMock.mockResolvedValue(
      productoCompleto({ nombre: "Cuchillo </script><script>alert(1)</script>" }),
    );

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    // Solo pueden existir los dos cierres de los dos bloques JSON-LD.
    expect(res.text.match(/<\/script>/g)).toHaveLength(2);
    expect(res.text).not.toContain("<script>alert(1)</script>");
  });
});
