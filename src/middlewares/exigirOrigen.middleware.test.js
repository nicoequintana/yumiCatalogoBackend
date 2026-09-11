import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { manejadorDeErrores } from "./errorHandler.js";
import { crearExigirOrigen } from "./exigirOrigen.middleware.js";

function buildApp(origenes = ["https://yima-productos.com", "http://localhost:5173"]) {
  const app = express();
  app.use(express.json());
  const exigir = crearExigirOrigen({ origenesPermitidos: origenes });
  app.get("/x", exigir, (_req, res) => res.json({ ok: true }));
  app.post("/x", exigir, (_req, res) => res.json({ ok: true }));
  app.delete("/x", exigir, (_req, res) => res.json({ ok: true }));
  app.use(manejadorDeErrores);
  return app;
}

describe("exigirOrigen", () => {
  it("un GET pasa sin Origin: no muta nada", async () => {
    expect((await request(buildApp()).get("/x")).status).toBe(200);
  });

  it("un POST con Origin permitido pasa", async () => {
    const res = await request(buildApp()).post("/x").set("Origin", "https://yima-productos.com").send({});
    expect(res.status).toBe(200);
  });

  it("un POST SIN Origin es 403 ORIGEN_RECHAZADO: los navegadores siempre lo mandan en una mutacion", async () => {
    const res = await request(buildApp()).post("/x").send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Origen no permitido.", codigo: "ORIGEN_RECHAZADO" });
  });

  it("un POST con Origin de otro sitio es 403 aunque traiga cookie", async () => {
    const res = await request(buildApp())
      .post("/x")
      .set("Origin", "https://atacante.com")
      .set("Cookie", "sesion_cliente=lo-que-sea")
      .send({});
    expect(res.status).toBe(403);
  });

  it("compara el origen exacto: subdominio o esquema distinto no pasan", async () => {
    expect((await request(buildApp()).post("/x").set("Origin", "http://yima-productos.com").send({})).status).toBe(403);
    expect((await request(buildApp()).post("/x").set("Origin", "https://evil.yima-productos.com").send({})).status).toBe(403);
    expect((await request(buildApp()).post("/x").set("Origin", "https://yima-productos.com.atacante.com").send({})).status).toBe(403);
  });

  it("DELETE tambien exige Origin", async () => {
    expect((await request(buildApp()).delete("/x")).status).toBe(403);
  });

  it("con Origin 'null' (sandbox, redirect cross-site) rechaza", async () => {
    expect((await request(buildApp()).post("/x").set("Origin", "null").send({})).status).toBe(403);
  });
});
