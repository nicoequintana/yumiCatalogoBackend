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
  // Por defecto el usuario del token existe y su versión de sesión es la 0 (la
  // que backfillea la migración): es el caso normal, y así los tests que no
  // hablan de revocación no tienen que setearlo uno por uno. Los tokens de esos
  // tests se firman con `tokenVersion: 0` para coincidir.
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
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
    const token = jwt.sign({ sub: 1, tokenVersion: 0 }, "test-secret", { expiresIn: "24h" });
    const res = await request(buildApp())
      .get("/protegido")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("expone la identidad del admin en req.usuario a partir del payload del token", async () => {
    const token = jwt.sign({ sub: 7, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
      expiresIn: "24h",
    });
    const res = await request(buildApp())
      .get("/quien-soy")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // `req.usuario` es solo la identidad — `tokenVersion` no se filtra a los
    // controllers ni a la auditoría.
    expect(res.body.usuario).toEqual({ id: 7, email: "admin@yima.test", puedeEliminar: true });
  });

  it("tolera tokens sin email en el payload (email queda null, no rompe)", async () => {
    // Un token con `tokenVersion` válido pero sin el claim `email` (por ejemplo
    // uno emitido antes de agregar `email` al payload) deja `email` en `null`,
    // sin tirar 401 ni romper. Se firma con `tokenVersion: 0` para aislar la
    // normalización del email de la revocación por versión.
    const tokenSinEmail = jwt.sign({ sub: 3, tokenVersion: 0 }, "test-secret", { expiresIn: "24h" });
    const res = await request(buildApp())
      .get("/quien-soy")
      .set("Authorization", `Bearer ${tokenSinEmail}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario).toEqual({ id: 3, email: null, puedeEliminar: true });
  });

  it("normaliza un sub no numérico a null en vez de propagar NaN", async () => {
    const token = jwt.sign({ sub: "no-numerico", email: "admin@yima.test" }, "test-secret", {
      expiresIn: "7d",
    });
    const res = await request(buildApp())
      .get("/quien-soy")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // `sub` no numérico: no hay fila que consultar, así que el permiso queda
    // fail-closed en `false` — la sesión sigue valiendo, el borrado no.
    expect(res.body.usuario).toEqual({ id: null, email: "admin@yima.test", puedeEliminar: false });
  });
});

describe("authOpcional", () => {
  it("deja pasar como anónimo si falta el header Authorization", async () => {
    const res = await request(buildApp()).get("/publico");
    expect(res.status).toBe(200);
    expect(res.body.usuario).toBeNull();
  });

  it("expone la identidad del admin cuando el token es válido", async () => {
    const token = jwt.sign({ sub: 7, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
      expiresIn: "24h",
    });
    const res = await request(buildApp()).get("/publico").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.usuario).toEqual({ id: 7, email: "admin@yima.test", puedeEliminar: true });
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
    expect(res.body.usuario).toEqual({ id: null, email: null, puedeEliminar: false });
  });
});

describe("revocación de sesión: el usuario del token tiene que seguir existiendo", () => {
  // Borrar un admin desde /catalogo/admin/usuarios tiene que revocarle el
  // acceso YA, no dentro de 7 días cuando expire su JWT. El caso de uso típico
  // de borrar un usuario es exactamente ese.
  const token = jwt.sign({ sub: 7, email: "borrado@yima.test", tokenVersion: 0 }, "test-secret", {
    expiresIn: "24h",
  });

  it("requireAuth responde 401 con un token válido de un usuario que ya no existe", async () => {
    usuarioFindUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "No autorizado." });
  });

  it("requireAuth consulta solo { id, tokenVersion, puedeEliminar } (no trae passwordHash ni nada más)", async () => {
    await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${token}`);

    expect(usuarioFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { id: true, tokenVersion: true, puedeEliminar: true },
    });
  });

  it("requireAuth deja pasar cuando el usuario del token sigue existiendo y su versión coincide", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 7, tokenVersion: 0 });

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

describe("revocación de sesión por versión de token (tokenVersion)", () => {
  // Cambiar la contraseña de un admin incrementa su `tokenVersion` en la base;
  // el JWT lleva la versión con la que se emitió. Si el token quedó atrás
  // (versión anterior a la de la base), la sesión está revocada — es lo que
  // hace que rotar la contraseña cierre en el acto todas las sesiones ya
  // abiertas, no dentro de 24 h cuando expire cada token.

  it("requireAuth deja pasar cuando la versión del token coincide con la de la base", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 7, tokenVersion: 3 });
    const token = jwt.sign({ sub: 7, email: "admin@yima.test", tokenVersion: 3 }, "test-secret", {
      expiresIn: "24h",
    });

    const res = await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("requireAuth trae { id, tokenVersion, puedeEliminar } en UNA sola consulta", async () => {
    const token = jwt.sign({ sub: 7, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
      expiresIn: "24h",
    });

    await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${token}`);

    expect(usuarioFindUniqueMock).toHaveBeenCalledTimes(1);
    expect(usuarioFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 7 },
      select: { id: true, tokenVersion: true, puedeEliminar: true },
    });
  });

  it("requireAuth responde 401 si la versión del token quedó atrás de la de la base", async () => {
    // La contraseña se rotó después de emitir este token: la base ya va por la
    // versión 4 y el token sigue en la 3.
    usuarioFindUniqueMock.mockResolvedValue({ id: 7, tokenVersion: 4 });
    const token = jwt.sign({ sub: 7, email: "admin@yima.test", tokenVersion: 3 }, "test-secret", {
      expiresIn: "24h",
    });

    const res = await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "No autorizado." });
  });

  it("requireAuth revoca un token VIEJO sin claim tokenVersion frente al 0 de la base (fail-closed deliberado)", async () => {
    // Los tokens emitidos antes de esta feature no traen el claim. NO coinciden
    // con el 0 con que la migración backfilleó la columna, así que quedan
    // revocados: el deploy fuerza un único re-login e invalida todo token viejo
    // en circulación.
    usuarioFindUniqueMock.mockResolvedValue({ id: 7, tokenVersion: 0 });
    const tokenViejo = jwt.sign({ sub: 7, email: "admin@yima.test" }, "test-secret", { expiresIn: "24h" });

    const res = await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${tokenViejo}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "No autorizado." });
  });

  it("authOpcional degrada a anónimo (200, sin usuario) si la versión del token quedó atrás — NUNCA corta", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 7, tokenVersion: 4 });
    const token = jwt.sign({ sub: 7, email: "admin@yima.test", tokenVersion: 3 }, "test-secret", {
      expiresIn: "24h",
    });

    const res = await request(buildApp()).get("/publico").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.usuario).toBeNull();
  });

  it("authOpcional también revoca un token viejo sin claim tokenVersion (degrada a anónimo)", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 7, tokenVersion: 0 });
    const tokenViejo = jwt.sign({ sub: 7, email: "admin@yima.test" }, "test-secret", { expiresIn: "24h" });

    const res = await request(buildApp()).get("/publico").set("Authorization", `Bearer ${tokenViejo}`);

    expect(res.status).toBe(200);
    expect(res.body.usuario).toBeNull();
  });

  it("una versión desincronizada NO revoca si la consulta falla (fail-open ante error de DB, no ante versión distinta)", async () => {
    // El fail-open cubre SOLO el error de la consulta. Una versión distinta con
    // la consulta respondiendo bien sí revoca — son dos cosas separadas.
    usuarioFindUniqueMock.mockRejectedValue(new Error("DB caída"));
    const token = jwt.sign({ sub: 7, email: "admin@yima.test", tokenVersion: 3 }, "test-secret", {
      expiresIn: "24h",
    });

    const res = await request(buildApp()).get("/protegido").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
  });
});

describe("requireAuth - permiso de borrado", () => {
  const tokenDe7 = jwt.sign({ sub: 7, email: "a@b.c", tokenVersion: 0 }, process.env.JWT_SECRET);

  // Sale de la BASE, no del JWT: quitarle el permiso a alguien tiene que surtir
  // efecto en la request siguiente, no cuando expire su token 24 horas después.
  // Y viaja en la MISMA consulta que ya verificaba la revocación de sesión, así
  // que no cuesta un round-trip extra.
  it("expone puedeEliminar en req.usuario leyéndolo de la base", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 7, tokenVersion: 0, puedeEliminar: false });

    const res = await request(buildApp()).get("/quien-soy").set("Authorization", `Bearer ${tokenDe7}`);

    expect(res.status).toBe(200);
    expect(res.body.usuario.puedeEliminar).toBe(false);
  });

  it("expone puedeEliminar en true cuando el usuario lo tiene", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 7, tokenVersion: 0, puedeEliminar: true });

    const res = await request(buildApp()).get("/quien-soy").set("Authorization", `Bearer ${tokenDe7}`);

    expect(res.body.usuario.puedeEliminar).toBe(true);
  });

  // FAIL-CLOSED ante el fail-open de la consulta. `sesionRevocada` deja pasar
  // si la base no contesta (decisión de disponibilidad, ver su docstring), pero
  // en ese caso NO se puede afirmar que el usuario tenga permiso de borrar. Las
  // dos cosas conviven: la sesión sigue viva, el borrado no.
  it("niega el permiso cuando la consulta a la base falla", async () => {
    usuarioFindUniqueMock.mockRejectedValue(new Error("base caída"));

    const res = await request(buildApp()).get("/quien-soy").set("Authorization", `Bearer ${tokenDe7}`);

    expect(res.status).toBe(200);
    expect(res.body.usuario.puedeEliminar).toBe(false);
  });

  // Una fila vieja sin la columna (o un mock incompleto) no puede otorgar
  // permiso por omisión.
  it("niega el permiso si la fila no trae el campo", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 7, tokenVersion: 0 });

    const res = await request(buildApp()).get("/quien-soy").set("Authorization", `Bearer ${tokenDe7}`);

    expect(res.body.usuario.puedeEliminar).toBe(false);
  });
});
