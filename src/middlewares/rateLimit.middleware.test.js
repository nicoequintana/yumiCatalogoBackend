import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";

const { crearLimitadorDeVelocidad } = await import("./rateLimit.middleware.js");

function buildApp(limiterOptions, { trustProxy = false } = {}) {
  const app = express();
  if (trustProxy) app.set("trust proxy", true);
  app.post("/probar", crearLimitadorDeVelocidad(limiterOptions), (_req, res) => res.json({ ok: true }));
  return app;
}

describe("crearLimitadorDeVelocidad", () => {
  it("permite las solicitudes dentro del límite", async () => {
    const app = buildApp({ windowMs: 60_000, max: 3, message: "Demasiados intentos." });

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/probar");
      expect(res.status).toBe(200);
    }
  });

  it("responde 429 con el shape de error del proyecto al superar el límite", async () => {
    const app = buildApp({ windowMs: 60_000, max: 2, message: "Demasiados intentos, probá de nuevo más tarde." });

    await request(app).post("/probar");
    await request(app).post("/probar");
    const res = await request(app).post("/probar");

    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "Demasiados intentos, probá de nuevo más tarde." });
  });

  it("usa un mensaje por defecto en español si no se especifica message", async () => {
    const app = buildApp({ windowMs: 60_000, max: 1 });

    await request(app).post("/probar");
    const res = await request(app).post("/probar");

    expect(res.status).toBe(429);
    expect(res.body).toHaveProperty("error");
    expect(typeof res.body.error).toBe("string");
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  it("cuenta cada IP por separado (una IP bloqueada no afecta a otra)", async () => {
    // trust proxy: true simula el deploy real detrás del proxy de EasyPanel,
    // donde express-rate-limit debe confiar en X-Forwarded-For para
    // distinguir IPs de clientes reales.
    const app = buildApp({ windowMs: 60_000, max: 1, message: "Demasiados intentos." }, { trustProxy: true });

    const primeraIp = await request(app).post("/probar").set("X-Forwarded-For", "1.1.1.1");
    expect(primeraIp.status).toBe(200);

    const primeraIpBloqueada = await request(app).post("/probar").set("X-Forwarded-For", "1.1.1.1");
    expect(primeraIpBloqueada.status).toBe(429);

    const segundaIp = await request(app).post("/probar").set("X-Forwarded-For", "2.2.2.2");
    expect(segundaIp.status).toBe(200);
  });

  it("resetea el conteo pasada la ventana de tiempo", async () => {
    const app = buildApp({ windowMs: 50, max: 1, message: "Demasiados intentos." });

    const primera = await request(app).post("/probar");
    expect(primera.status).toBe(200);

    const bloqueada = await request(app).post("/probar");
    expect(bloqueada.status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 80));

    const despuesDeLaVentana = await request(app).post("/probar");
    expect(despuesDeLaVentana.status).toBe(200);
  });

  it("es reutilizable con distintos límites por instancia (sin hardcodear valores de login)", async () => {
    const appEstricta = buildApp({ windowMs: 60_000, max: 1, message: "Límite A" });
    const appPermisiva = buildApp({ windowMs: 60_000, max: 5, message: "Límite B" });

    const resEstricta1 = await request(appEstricta).post("/probar");
    const resEstricta2 = await request(appEstricta).post("/probar");
    expect(resEstricta1.status).toBe(200);
    expect(resEstricta2.status).toBe(429);
    expect(resEstricta2.body).toEqual({ error: "Límite A" });

    for (let i = 0; i < 5; i++) {
      const res = await request(appPermisiva).post("/probar");
      expect(res.status).toBe(200);
    }
    const resPermisivaBloqueada = await request(appPermisiva).post("/probar");
    expect(resPermisivaBloqueada.status).toBe(429);
    expect(resPermisivaBloqueada.body).toEqual({ error: "Límite B" });
  });
});
