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
    expect(res.text).toContain("Aura Prestigio");
    expect(res.text).toContain("https://aura.example.com/og-default.svg");
  });

  it("escapa HTML en nombre y descripción para evitar inyección", async () => {
    findUniqueMock.mockResolvedValue({
      id: 5,
      nombre: '<script>alert(1)</script>',
      descripcion: "Descripción normal.",
      fotos: [],
    });

    const res = await request(buildApp())
      .get("/og/producto/5")
      .set("User-Agent", "WhatsApp/2.23.20.0");

    expect(res.text).not.toContain("<script>alert(1)</script>");
    expect(res.text).toContain("&lt;script&gt;");
  });
});
