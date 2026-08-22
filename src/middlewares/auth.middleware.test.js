import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const usuarioFindUniqueMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    usuario: {
      findUnique: (...args) => usuarioFindUniqueMock(...args),
    },
  },
}));

const { requireAuth, authOpcional } = await import("./auth.middleware.js");

beforeEach(() => {
  usuarioFindUniqueMock.mockReset();
  // Por defecto el usuario del token existe: es el caso normal, y así los
  // tests que no hablan de revocación no tienen que setearlo uno por uno.
  usuarioFindUniqueMock.mockResolvedValue({ id: 1 });
});

function buildApp() {
  const app = express();
  app.get("/protegido", requireAuth, (_req, res) => res.json({ ok: true }));
  app.get("/quien-soy", requireAuth, (req, res) => res.json({ usuario: req.usuario ?? null }));
  app.get("/publico", authOpcional, (req, res) => res.json({ usuario: req.usuario ?? null }));
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

  it("expone la identidad del admin en req.usuario a partir del payload del token", async () => {
    const token = jwt.sign({ sub: 7, email: "admin@yima.test" }, "test-secret", { expiresIn: "7d" });
    const res = await request(buildApp())
      .get("/quien-soy")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario).toEqual({ id: 7, email: "admin@yima.test" });
  });

  it("tolera tokens viejos sin email en el payload (email queda null, no rompe)", async () => {
    // Tokens emitidos antes de agregar `email` al payload siguen siendo
    // válidos hasta que expiren (7 días) — no deben tirar 401 ni romper.
    const tokenViejo = jwt.sign({ sub: 3 }, "test-secret", { expiresIn: "7d" });
    const res = await request(buildApp())
      .get("/quien-soy")
      .set("Authorization", `Bearer ${tokenViejo}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario).toEqual({ id: 3, email: null });
  });

  it("normaliza un sub no numérico a null en vez de propagar NaN", async () => {
    const token = jwt.sign({ sub: "no-numerico", email: "admin@yima.test" }, "test-secret", {
      expiresIn: "7d",
    });
    const res = await request(buildApp())
      .get("/quien-soy")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario).toEqual({ id: null, email: "admin@yima.test" });
  });
});

describe("authOpcional", () => {
  it("deja pasar como anónimo si falta el header Authorization", async () => {
    const res = await request(buildApp()).get("/publico");
    expect(res.status).toBe(200);
    expect(res.body.usuario).toBeNull();
  });

  it("expone la identidad del admin cuando el token es válido", async () => {
    const token = jwt.sign({ sub: 7, email: "admin@yima.test" }, "test-secret", { expiresIn: "7d" });
    const res = await request(buildApp()).get("/publico").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario).toEqual({ id: 7, email: "admin@yima.test" });
  });

  it("degrada a anónimo (200, sin req.usuario) si el token es basura", async () => {
    const res = await request(buildApp()).get("/publico").set("Authorization", "Bearer token-invalido");
    expect(res.status).toBe(200);
    expect(res.body.usuario).toBeNull();
  });

  it("degrada a anónimo si el token está expirado, en vez de responder 401", async () => {
    const tokenExpirado = jwt.sign({ sub: 1 }, "test-secret", { expiresIn: -10 });
    const res = await request(buildApp()).get("/publico").set("Authorization", `Bearer ${tokenExpirado}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario).toBeNull();
  });

  it("degrada a anónimo si el header no usa el esquema Bearer", async () => {
    const res = await request(buildApp()).get("/publico").set("Authorization", "Basic YWRtaW46MTIzNA==");
    expect(res.status).toBe(200);
    expect(res.body.usuario).toBeNull();
  });

  it("no acepta un token firmado con otro algoritmo (alg confusion)", async () => {
    // Mismo `algorithms: ["HS256"]` que `requireAuth`: los dos middlewares
    // comparten la verificación, así que esta guarda no puede divergir.
    const token = jwt.sign({ sub: 9, email: "admin@yima.test" }, "test-secret", {
      algorithm: "HS512",
      expiresIn: "7d",
    });
    const res = await request(buildApp()).get("/publico").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario).toBeNull();
  });

  it("normaliza el payload igual que requireAuth (sub no numérico -> null, sin email -> null)", async () => {
    const token = jwt.sign({ sub: "no-numerico" }, "test-secret", { expiresIn: "7d" });
    const res = await request(buildApp()).get("/publico").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario).toEqual({ id: null, email: null });
  });
});

describe("revocación de sesión: el usuario del token tiene que seguir existiendo", () => {
  // Borrar un admin desde /catalogo/admin/usuarios tiene que revocarle el
  // acceso YA, no dentro de 7 días cuando expire su JWT. El caso de uso típico
  // de borrar un usuario es exactamente ese.
  const token = jwt.sign({ sub: 7, email: "borrado@yima.test" }, "test-secret", { expiresIn: "7d" });

  it("requireAuth responde 401 con un token válido de un usuario que ya no existe", async () => {
    usuarioFindUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "No autorizado." });
  });

  it("requireAuth consulta solo el id (no trae passwordHash ni nada más)", async () => {
    await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${token}`);

    expect(usuarioFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { id: true },
    });
  });

  it("requireAuth deja pasar cuando el usuario del token sigue existiendo", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 7 });

    const res = await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });

  it("authOpcional degrada a anónimo (200, sin usuario) si el usuario fue borrado — NUNCA corta la request", async () => {
    // Es un endpoint público: un 401 acá rompería el catálogo para quien
    // navega con un token de un admin borrado, en vez de mostrarle lo público.
    usuarioFindUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/publico").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.usuario).toBeNull();
  });

  it("authOpcional no consulta la base para un visitante anónimo (sin token no hay nada que verificar)", async () => {
    const res = await request(buildApp()).get("/publico");

    expect(res.status).toBe(200);
    expect(usuarioFindUniqueMock).not.toHaveBeenCalled();
  });

  it("si la consulta de existencia falla, NO revoca (fail-open documentado)", async () => {
    // La revocación solo actúa ante la respuesta definitiva de Prisma (null =
    // borrado). Si la base no contesta, cortar acá convertiría un hipo de DB
    // en un logout masivo — y cualquier operación real va a fallar igual
    // contra esa misma base con su propio error.
    usuarioFindUniqueMock.mockRejectedValue(new Error("DB caída"));

    const res = await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});
