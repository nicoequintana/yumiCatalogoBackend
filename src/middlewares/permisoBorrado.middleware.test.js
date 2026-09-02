import { describe, expect, it } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "./errorHandler.js";

const { requierePermisoDeBorrado } = await import("./permisoBorrado.middleware.js");

function buildApp(usuario) {
  const app = express();
  app.use((req, _res, next) => {
    if (usuario) req.usuario = usuario;
    next();
  });
  app.delete("/recurso/:id", requierePermisoDeBorrado, (_req, res) => res.json({ borrado: true }));
  app.use(manejadorDeErrores);
  return app;
}

describe("requierePermisoDeBorrado", () => {
  it("deja pasar a un admin con permiso", async () => {
    const res = await request(buildApp({ id: 1, email: "a@b.c", puedeEliminar: true })).delete("/recurso/7");

    expect(res.status).toBe(200);
    expect(res.body.borrado).toBe(true);
  });

  it("responde 403 a un admin sin permiso", async () => {
    const res = await request(buildApp({ id: 2, email: "x@y.z", puedeEliminar: false })).delete("/recurso/7");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("permiso");
  });

  // FAIL-CLOSED. `requireAuth` puebla `puedeEliminar` desde la base, pero si
  // alguna vez un camino nuevo dejara `req.usuario` sin ese campo, la respuesta
  // segura es negar. Asumir permiso ante la duda es exactamente el bug que este
  // middleware existe para prevenir.
  it("niega cuando el campo no viene (fail-closed)", async () => {
    const res = await request(buildApp({ id: 3, email: "s@t.u" })).delete("/recurso/7");

    expect(res.status).toBe(403);
  });

  // El middleware asume que `requireAuth` ya corrió. Sin usuario, la respuesta
  // correcta es 401 y no 403: "no sé quién sos" es distinto de "sé quién sos y
  // no podés".
  it("responde 401 si no hay usuario autenticado", async () => {
    const res = await request(buildApp(null)).delete("/recurso/7");

    expect(res.status).toBe(401);
  });
});
