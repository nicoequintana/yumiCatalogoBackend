import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const { requireAuth } = await import("./auth.middleware.js");

function buildApp() {
  const app = express();
  app.get("/protegido", requireAuth, (_req, res) => res.json({ ok: true }));
  return app;
}

describe("requireAuth", () => {
  it("responde 401 si falta el header Authorization", async () => {
    const res = await request(buildApp()).get("/protegido");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "No autorizado." });
  });

  it("responde 401 si el token es inválido", async () => {
    const res = await request(buildApp())
      .get("/protegido")
      .set("Authorization", "Bearer token-invalido");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "No autorizado." });
  });

  it("responde 401 si el token está expirado", async () => {
    const tokenExpirado = jwt.sign({ sub: 1 }, "test-secret", { expiresIn: -10 });
    const res = await request(buildApp())
      .get("/protegido")
      .set("Authorization", `Bearer ${tokenExpirado}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "No autorizado." });
  });

  it("deja pasar si el token es válido", async () => {
    const token = jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" });
    const res = await request(buildApp())
      .get("/protegido")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
