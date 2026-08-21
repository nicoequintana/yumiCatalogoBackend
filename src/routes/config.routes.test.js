import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

const { default: configRouter } = await import("./config.routes.js");

function buildApp() {
  const app = express();
  app.use("/api/config", configRouter);
  app.use(manejadorDeErrores);
  return app;
}

const ENV_BASE = {
  WHATSAPP_NUMERO: "5491122334455",
  WHATSAPP_HORA_DESDE: "9",
  WHATSAPP_HORA_HASTA: "18",
  WHATSAPP_DIAS: "1,2,3,4,5",
};

beforeEach(() => {
  Object.assign(process.env, ENV_BASE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/config/whatsapp", () => {
  it("devuelve dentroDeHorario=true y el texto correspondiente en horario hábil", async () => {
    // Miércoles 2026-01-07 10:00 ART = 13:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-07T13:00:00.000Z"));

    const res = await request(buildApp()).get("/api/config/whatsapp");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      numero: "5491122334455",
      dentroDeHorario: true,
      textoHorario: "Te respondemos ahora",
    });
  });

  it("devuelve dentroDeHorario=false y el texto correspondiente fuera de horario", async () => {
    // Miércoles 2026-01-07 20:00 ART = 23:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-07T23:00:00.000Z"));

    const res = await request(buildApp()).get("/api/config/whatsapp");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      numero: "5491122334455",
      dentroDeHorario: false,
      textoHorario: "Fuera de horario de atención — te respondemos apenas podamos",
    });
  });

  it("dentroDeHorario=false en un día no habilitado (domingo)", async () => {
    // Domingo 2026-01-04 10:00 ART = 13:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T13:00:00.000Z"));

    const res = await request(buildApp()).get("/api/config/whatsapp");

    expect(res.status).toBe(200);
    expect(res.body.dentroDeHorario).toBe(false);
  });

  it("no requiere autenticación", async () => {
    const res = await request(buildApp()).get("/api/config/whatsapp");
    expect(res.status).not.toBe(401);
  });
});
