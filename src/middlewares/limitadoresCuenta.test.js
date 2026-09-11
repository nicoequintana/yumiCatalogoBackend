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

describe("headers RateLimit-* del limitador por destino", () => {
  it("un email ya sondeado muestra los MISMOS headers que uno fresco: el contador por email no se filtra (enumeración)", async () => {
    // Misma cadena que `/registro`: primero el de IP (acá keyeado por un
    // header para simular IPs distintas), después el por destino.
    const porIp = crearLimitadorDeVelocidad({
      windowMs: 60_000,
      max: 15,
      message: MENSAJE_429_CUENTA,
      keyGenerator: (req) => req.get("x-ip-prueba"),
    });
    const app = express();
    app.use(express.json());
    app.post("/x", porIp, crearLimitadorPorDestino({ windowMs: 60_000, max: 3 }), (_req, res) => res.json({ ok: true }));

    await request(app).post("/x").set("x-ip-prueba", "a").send({ email: "sondeado@gmail.com" });
    await request(app).post("/x").set("x-ip-prueba", "b").send({ email: "sondeado@gmail.com" });

    const sondeado = await request(app).post("/x").set("x-ip-prueba", "c").send({ email: "sondeado@gmail.com" });
    const fresco = await request(app).post("/x").set("x-ip-prueba", "d").send({ email: "fresco@gmail.com" });

    expect(sondeado.status).toBe(200);
    expect(sondeado.headers["ratelimit-limit"]).toBe(fresco.headers["ratelimit-limit"]);
    expect(sondeado.headers["ratelimit-remaining"]).toBe(fresco.headers["ratelimit-remaining"]);
    expect(sondeado.headers["ratelimit-policy"]).toBe(fresco.headers["ratelimit-policy"]);
  });

  it("el limitador por destino no emite headers propios", async () => {
    const res = await request(appCon(crearLimitadorPorDestino({ windowMs: 60_000, max: 3 })))
      .post("/x")
      .send({ email: "v@gmail.com" });
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
    expect(res.headers["ratelimit-remaining"]).toBeUndefined();
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
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
