import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const findManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: { product: { findMany: (...args) => findManyMock(...args) } },
}));

const { default: sitemapRouter } = await import("./sitemap.routes.js");

function buildApp() {
  const app = express();
  app.use("/sitemap.xml", sitemapRouter);
  return app;
}

beforeEach(() => {
  findManyMock.mockReset();
  process.env.FRONTEND_URL = "https://aura.example.com";
});

describe("GET /sitemap.xml", () => {
  it("devuelve XML con Content-Type application/xml", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/sitemap.xml");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/xml/);
  });

  it("incluye la raíz del sitio y solo productos visibleEnCatalogo=true, filtrados por Prisma", async () => {
    findManyMock.mockResolvedValue([
      { id: 5, updatedAt: new Date("2026-01-10T12:00:00.000Z") },
      { id: 9, updatedAt: new Date("2026-02-20T08:30:00.000Z") },
    ]);

    const res = await request(buildApp()).get("/sitemap.xml");

    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { visibleEnCatalogo: true } })
    );
    expect(res.text).toContain("<loc>https://aura.example.com/</loc>");
    expect(res.text).toContain("<loc>https://aura.example.com/producto/5</loc>");
    expect(res.text).toContain("<lastmod>2026-01-10T12:00:00.000Z</lastmod>");
    expect(res.text).toContain("<loc>https://aura.example.com/producto/9</loc>");
    expect(res.text).toContain("<lastmod>2026-02-20T08:30:00.000Z</lastmod>");
  });

  it("respeta el esquema estándar de sitemap (urlset con namespace)", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/sitemap.xml");

    expect(res.text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(res.text).toContain("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    expect(res.text).toContain("</urlset>");
  });

  it("catálogo vacío produce un sitemap válido (solo la raíz), no un error", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/sitemap.xml");

    expect(res.status).toBe(200);
    expect(res.text).toContain("<loc>https://aura.example.com/</loc>");
    expect(res.text).not.toContain("/producto/");
  });

  it("escapa caracteres especiales de XML en las URLs generadas", async () => {
    findManyMock.mockResolvedValue([
      { id: 7, updatedAt: new Date("2026-03-01T00:00:00.000Z") },
    ]);
    process.env.FRONTEND_URL = "https://aura.example.com?tag=a&b";

    const res = await request(buildApp()).get("/sitemap.xml");

    expect(res.text).toContain("&amp;");
    expect(res.text).not.toMatch(/tag=a&b/);
  });

  it("propaga errores de Prisma al middleware de errores (no cuelga la respuesta)", async () => {
    findManyMock.mockRejectedValue(new Error("DB down"));

    const app = buildApp();
    app.use((err, _req, res, _next) => {
      res.status(500).json({ error: "fail" });
    });

    const res = await request(app).get("/sitemap.xml");

    expect(res.status).toBe(500);
  });
});
