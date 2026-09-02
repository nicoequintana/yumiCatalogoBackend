import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

const queryRawMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    $queryRaw: (...args) => queryRawMock(...args),
  },
}));

const { default: healthRouter } = await import("./health.routes.js");

function buildApp() {
  const app = express();
  app.use("/health", healthRouter);
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  queryRawMock.mockReset();
});

describe("GET /health", () => {
  it("devuelve 200 con ok:true cuando la base responde", async () => {
    queryRawMock.mockResolvedValue([{ ok: 1 }]);

    const res = await request(buildApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, db: "ok" });
  });

  // EL CASO QUE MOTIVA TODO ESTO: antes `/health` devolvía `{ok:true}` sin
  // tocar nada, así que un contenedor con la base caída pasaba el health check
  // de EasyPanel y se quedaba en rotación sirviendo 500 a todo el mundo.
  it("devuelve 503 cuando la base no responde", async () => {
    queryRawMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(buildApp()).get("/health");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, db: "unreachable" });
  });

  // El detalle del fallo de la base (host, puerto, credenciales del connection
  // string) no puede salir en un endpoint público sin auth.
  it("no filtra el mensaje de error de la base", async () => {
    queryRawMock.mockRejectedValue(
      new Error("Login failed for user 'sa' at 10.0.0.7:1433"),
    );

    const res = await request(buildApp()).get("/health");

    expect(JSON.stringify(res.body)).not.toContain("sa");
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.7");
  });

  // Una base colgada (que no rechaza, simplemente no contesta) es el caso peor:
  // sin timeout, el health check queda esperando y el orquestador lo interpreta
  // como caída del contenedor entero en vez de como base inalcanzable.
  it("no espera indefinidamente si la base cuelga", async () => {
    queryRawMock.mockImplementation(() => new Promise(() => {}));

    const res = await request(buildApp()).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.db).toBe("unreachable");
  }, 10_000);
});
