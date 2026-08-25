import { describe, expect, it, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import robotsRouter from "./robots.routes.js";

function buildApp() {
  const app = express();
  app.use("/robots.txt", robotsRouter);
  return app;
}

beforeEach(() => {
  process.env.FRONTEND_URL = "https://yima.example.com";
});

describe("GET /robots.txt", () => {
  it("responde texto plano", async () => {
    const res = await request(buildApp()).get("/robots.txt");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
  });

  it("declara el sitemap en el dominio del frontend", async () => {
    const res = await request(buildApp()).get("/robots.txt");

    expect(res.text).toContain("Sitemap: https://yima.example.com/sitemap.xml");
  });

  it("bloquea el panel admin", async () => {
    const res = await request(buildApp()).get("/robots.txt");
    expect(res.text).toContain("Disallow: /catalogo/admin");
  });

  it("NO bloquea carrito, checkout ni favoritos", async () => {
    const res = await request(buildApp()).get("/robots.txt");

    // Un Disallow acá impediría que el crawler entre a leer el `noindex`, y
    // la URL se indexaría igual si alguien la linkea. Se resuelven con la
    // meta tag, no con robots.txt.
    expect(res.text).not.toContain("Disallow: /carrito");
    expect(res.text).not.toContain("Disallow: /checkout");
    expect(res.text).not.toContain("Disallow: /favoritos");
  });
});
