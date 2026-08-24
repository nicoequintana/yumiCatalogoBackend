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

beforeEach(() => {
  findUniqueMock.mockReset();
  process.env.FRONTEND_URL = "https://aura.example.com";
  process.env.BACKEND_PUBLIC_URL = "https://api.aura.example.com";
});

describe("GET /og/producto/:id", () => {
  it("devuelve HTML con meta tags OG cuando el user-agent es un bot conocido", async () => {
    findUniqueMock.mockResolvedValue({
      id: 5,
      nombre: "Anillo Solitario",
      descripcion: "Un anillo de oro 18k con diamante central.",
      fotos: [{ id: 1, orden: 0, url: "https://res.cloudinary.com/demo/anillo.jpg", cloudinaryPublicId: "anillo", driveFileId: null }],
      visibleEnCatalogo: true,
    });

    const res = await request(buildApp())
      .get("/og/producto/5")
      .set("User-Agent", "facebookexternalhit/1.1");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain('property="og:title"');
    expect(res.text).toContain("Anillo Solitario");
    expect(res.text).toContain("https://res.cloudinary.com/demo/anillo.jpg");
    expect(res.text).toContain("https://aura.example.com/producto/5");
  });

  it("redirige 302 a la SPA cuando el user-agent es un navegador normal", async () => {
    findUniqueMock.mockResolvedValue({
      id: 5,
      nombre: "Anillo Solitario",
      descripcion: "Un anillo de oro 18k.",
      fotos: [],
    });

    const res = await request(buildApp())
      .get("/og/producto/5")
      .set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://aura.example.com/producto/5");
  });

  it("devuelve tags genéricos (200) si el producto no existe, en vez de 404", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp())
      .get("/og/producto/999")
      .set("User-Agent", "Twitterbot/1.0");

    expect(res.status).toBe(200);
    expect(res.text).toContain("YIMA Productos");
    expect(res.text).toContain("https://aura.example.com/og-default.png");
  });

  it("devuelve tags genéricos (200) para id no-numérico sin consultar Prisma", async () => {
    const res = await request(buildApp())
      .get("/og/producto/abc")
      .set("User-Agent", "Twitterbot/1.0");

    expect(res.status).toBe(200);
    expect(res.text).toContain("YIMA Productos");
    expect(res.text).toContain("https://aura.example.com/og-default.png");
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("devuelve tags genéricos (200) para un id fraccionario sin consultar Prisma", async () => {
    // `Number("1.5")` no es NaN: con el chequeo viejo el float llegaba a
    // Prisma como filtro sobre `id Int` y el 500 resultante rompía el preview
    // del link. Mismo destino que un id no numérico: HTML genérico, sin base.
    const res = await request(buildApp())
      .get("/og/producto/1.5")
      .set("User-Agent", "Twitterbot/1.0");

    expect(res.status).toBe(200);
    expect(res.text).toContain("YIMA Productos");
    expect(res.text).toContain("https://aura.example.com/og-default.png");
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("escapa HTML en nombre y descripción para evitar inyección", async () => {
    findUniqueMock.mockResolvedValue({
      id: 5,
      nombre: '<script>alert(1)</script>',
      descripcion: "Descripción normal.",
      fotos: [],
      visibleEnCatalogo: true,
    });

    const res = await request(buildApp())
      .get("/og/producto/5")
      .set("User-Agent", "WhatsApp/2.23.20.0");

    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).toContain("&lt;script&gt;");
  });

  it("un producto oculto (visibleEnCatalogo=false) devuelve el HTML genérico, igual que uno inexistente", async () => {
    findUniqueMock.mockResolvedValue({
      id: 5,
      nombre: "Anillo Solitario",
      descripcion: "Un anillo de oro 18k con diamante central.",
      fotos: [{ id: 1, orden: 0, url: "https://res.cloudinary.com/demo/anillo.jpg", cloudinaryPublicId: "anillo", driveFileId: null }],
      visibleEnCatalogo: false,
    });

    const res = await request(buildApp())
      .get("/og/producto/5")
      .set("User-Agent", "facebookexternalhit/1.1");

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("Anillo Solitario");
    expect(res.text).toContain("YIMA Productos");
    expect(res.text).toContain("https://aura.example.com/og-default.png");
  });

  it("tiene un rate limit cableado, laxo, que no molesta a los bots legítimos de previews", async () => {
    // Público, sin auth, y con consulta a la base por request. El límite es
    // generoso a propósito: lo consumen los bots de redes sociales al armar
    // el preview de un link compartido, y apretarlo rompería justo eso. Se
    // verifica el CABLEADO (headers RateLimit-*) y que una tanda normal no se
    // bloquea; el 429 lo cubre `middlewares/rateLimit.middleware.test.js`.
    findUniqueMock.mockResolvedValue(null);
    const app = buildApp();

    for (let i = 0; i < 10; i++) {
      const res = await request(app).get("/og/producto/5").set("User-Agent", "Twitterbot/1.0");
      expect(res.status).toBe(200);
      expect(res.headers["ratelimit-limit"]).toBe("120");
    }
  });
});
