import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { manejadorDeErrores } from "./errorHandler.js";
import { crearLimitadorDeVelocidad } from "./rateLimit.middleware.js";
import { MENSAJE_429_CUENTA, claveDeDestino, crearLimitadorPorDestino } from "./limitadoresCuenta.js";

function appCon(limitador) {
  const app = express();
  app.use(express.json());
  app.post("/x", limitador, (_req, res) => res.json({ ok: true }));
  app.use(manejadorDeErrores);
  return app;
}

describe("claveDeDestino", () => {
  it("normaliza el email del body", () => {
    expect(claveDeDestino({ body: { email: "  Victima@Gmail.com " } })).toBe("victima@gmail.com");
  });

  it("devuelve null si falta, no es string o no parece un email", () => {
    expect(claveDeDestino({ body: {} })).toBeNull();
    expect(claveDeDestino({ body: { email: 42 } })).toBeNull();
    expect(claveDeDestino({ body: { email: "sin-arroba" } })).toBeNull();
  });

  it("acota el largo: un email de 90 KB no puede quedar 60 min en memoria", () => {
    const largo = `${"a".repeat(90_000)}@gmail.com`;
    expect(claveDeDestino({ body: { email: largo } })).toBeNull();
  });
});

describe("crearLimitadorPorDestino", () => {
  it("cuenta por email, no por IP: el mismo email desde IPs distintas comparte el balde", async () => {
    const app = appCon(crearLimitadorPorDestino({ windowMs: 60_000, max: 2 }));
    const ok1 = await request(app).post("/x").set("X-Forwarded-For", "1.1.1.1").send({ email: "v@gmail.com" });
    const ok2 = await request(app).post("/x").set("X-Forwarded-For", "2.2.2.2").send({ email: "V@gmail.com" });
    const bloqueado = await request(app).post("/x").set("X-Forwarded-For", "3.3.3.3").send({ email: "v@gmail.com" });
    expect(ok1.status).toBe(200);
    expect(ok2.status).toBe(200);
    expect(bloqueado.status).toBe(429);
  });

  it("emails distintos tienen baldes distintos", async () => {
    const app = appCon(crearLimitadorPorDestino({ windowMs: 60_000, max: 1 }));
    expect((await request(app).post("/x").send({ email: "a@gmail.com" })).status).toBe(200);
    expect((await request(app).post("/x").send({ email: "b@gmail.com" })).status).toBe(200);
  });

  it("sin email valido se SALTEA: un body vacio no puede compartir un balde para todos", async () => {
    const app = appCon(crearLimitadorPorDestino({ windowMs: 60_000, max: 1 }));
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post("/x").send({})).status).toBe(200);
    }
  });

  it("el cuerpo del 429 es el MISMO que el del limitador por IP", async () => {
    const porDestino = appCon(crearLimitadorPorDestino({ windowMs: 60_000, max: 0 }));
    const porIp = appCon(crearLimitadorDeVelocidad({ windowMs: 60_000, max: 0, message: MENSAJE_429_CUENTA }));
    const a = await request(porDestino).post("/x").send({ email: "v@gmail.com" });
    const b = await request(porIp).post("/x").send({ email: "v@gmail.com" });
    expect(a.status).toBe(429);
    expect(b.status).toBe(429);
    expect(a.body).toEqual(b.body);
  });
});

describe("crearLimitadorDeVelocidad — keyGenerator y skip", () => {
  it("acepta keyGenerator y skip y los pasa a express-rate-limit", async () => {
    const app = appCon(
      crearLimitadorDeVelocidad({
        windowMs: 60_000,
        max: 1,
        keyGenerator: (req) => req.body.k,
        skip: (req) => req.body.k === "libre",
      }),
    );
    expect((await request(app).post("/x").send({ k: "a" })).status).toBe(200);
    expect((await request(app).post("/x").send({ k: "a" })).status).toBe(429);
    expect((await request(app).post("/x").send({ k: "b" })).status).toBe(200);
    expect((await request(app).post("/x").send({ k: "libre" })).status).toBe(200);
    expect((await request(app).post("/x").send({ k: "libre" })).status).toBe(200);
  });
});
