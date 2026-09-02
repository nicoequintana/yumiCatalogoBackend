import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const findManyMock = vi.fn();
const findUniqueMock = vi.fn();
const authFindUniqueMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const deleteManyMock = vi.fn();
const countMock = vi.fn();
const auditCreateMock = vi.fn();

// `requireAuth` verifica la sesión del token con un `findUnique` de forma fija
// (`select: { id, tokenVersion, puedeEliminar }`). Se rutea a un mock propio
// para que los `mockResolvedValueOnce` de los tests del controller no se los
// consuma el middleware.
//
// El reconocimiento va por la FORMA EXACTA del select, así que al agregarle un
// campo a esa consulta hay que actualizar esto también — si no, el chequeo de
// auth cae en el mock del controller y toda la suite responde 401. Pasó al
// sumar `puedeEliminar`: el detector exigía exactamente 2 claves.
const SELECT_DE_AUTH = ["id", "tokenVersion", "puedeEliminar"];

function rutearFindUnique(args) {
  const claves = args?.select ? Object.keys(args.select) : [];
  const esChequeoDeAuth =
    claves.length === SELECT_DE_AUTH.length && SELECT_DE_AUTH.every((c) => args.select[c] === true);
  return esChequeoDeAuth ? authFindUniqueMock(args) : findUniqueMock(args);
}

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    usuario: {
      findMany: (...args) => findManyMock(...args),
      findUnique: (args) => rutearFindUnique(args),
      create: (...args) => createMock(...args),
      deleteMany: (...args) => deleteManyMock(...args),
      update: (...args) => updateMock(...args),
      count: (...args) => countMock(...args),
    },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    $transaction: async (fn) =>
      fn({
        usuario: {
          deleteMany: (...args) => deleteManyMock(...args),
          count: (...args) => countMock(...args),
        },
      }),
  },
}));

const { default: usuariosRouter } = await import("./usuarios.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/usuarios", usuariosRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "24h",
});
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  findManyMock.mockReset();
  findUniqueMock.mockReset();
  authFindUniqueMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  deleteManyMock.mockReset();
  countMock.mockReset();
  auditCreateMock.mockReset();
  auditCreateMock.mockResolvedValue({ id: 1 });
  // El admin del token existe y su versión de sesión coincide con la del token
  // (0): es el caso normal de toda la suite.
  authFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
});

describe("GET /api/usuarios", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/usuarios");
    expect(res.status).toBe(401);
  });

  it("lista usuarios sin exponer passwordHash", async () => {
    findManyMock.mockResolvedValue([
      { id: 1, email: "admin@test.com", createdAt: new Date("2026-01-01"), passwordHash: "no-deberia-aparecer" },
    ]);
    const res = await request(buildApp()).get("/api/usuarios").set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(res.body[0]).not.toHaveProperty("passwordHash");
    expect(findManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.not.objectContaining({ passwordHash: true }) })
    );
  });
});

describe("POST /api/usuarios", () => {
  it("crea un usuario con password hasheada", async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: 2, email: "nuevo@test.com", createdAt: new Date("2026-01-02") });

    const res = await request(buildApp())
      .post("/api/usuarios")
      .set("Authorization", authHeader)
      .send({ email: "nuevo@test.com", password: "clave12345" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 2, email: "nuevo@test.com", createdAt: "2026-01-02T00:00:00.000Z" });
    const dataPasada = createMock.mock.calls[0][0].data;
    expect(dataPasada.email).toBe("nuevo@test.com");
    expect(dataPasada.passwordHash).not.toBe("clave12345");
  });

  it("responde 400 si el email ya existe", async () => {
    findUniqueMock.mockResolvedValue({ id: 1, email: "admin@test.com" });
    const res = await request(buildApp())
      .post("/api/usuarios")
      .set("Authorization", authHeader)
      .send({ email: "admin@test.com", password: "clave12345" });
    expect(res.status).toBe(400);
  });

  it("responde 400 si falta email o password", async () => {
    const res = await request(buildApp())
      .post("/api/usuarios")
      .set("Authorization", authHeader)
      .send({ email: "sin-clave@test.com" });
    expect(res.status).toBe(400);
  });

  it("responde 400 si la contraseña tiene menos de 8 caracteres (misma política que create-admin.js)", async () => {
    const res = await request(buildApp())
      .post("/api/usuarios")
      .set("Authorization", authHeader)
      .send({ email: "nuevo@test.com", password: "a" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("La contraseña debe tener al menos 8 caracteres.");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("responde 400 si el email no tiene formato de email", async () => {
    const res = await request(buildApp())
      .post("/api/usuarios")
      .set("Authorization", authHeader)
      .send({ email: "no-es-un-email", password: "clave12345" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El email no tiene un formato válido.");
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("PUT /api/usuarios/:id", () => {
  it("actualiza el email sin tocar el password si no se manda uno nuevo", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 1, email: "viejo@test.com", passwordHash: "hash-viejo" });
    findUniqueMock.mockResolvedValueOnce(null);
    updateMock.mockResolvedValue({ id: 1, email: "nuevo@test.com", createdAt: new Date("2026-01-01") });

    const res = await request(buildApp())
      .put("/api/usuarios/1")
      .set("Authorization", authHeader)
      .send({ email: "nuevo@test.com" });

    expect(res.status).toBe(200);
    const dataPasada = updateMock.mock.calls[0][0].data;
    expect(dataPasada.email).toBe("nuevo@test.com");
    expect(dataPasada.passwordHash).toBeUndefined();
  });

  it("responde 400 si la contraseña nueva tiene menos de 8 caracteres", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 2, email: "otro@test.com", passwordHash: "hash" });

    const res = await request(buildApp())
      .put("/api/usuarios/2")
      .set("Authorization", authHeader)
      .send({ password: "corta" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("La contraseña debe tener al menos 8 caracteres.");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("responde 400 si el email nuevo no tiene formato de email", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 2, email: "otro@test.com", passwordHash: "hash" });

    const res = await request(buildApp())
      .put("/api/usuarios/2")
      .set("Authorization", authHeader)
      .send({ email: "sin-arroba" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El email no tiene un formato válido.");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("incrementa tokenVersion al cambiar la contraseña (revoca las sesiones ya abiertas)", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 2, email: "otro@test.com", passwordHash: "hash-viejo", tokenVersion: 1 });
    updateMock.mockResolvedValue({ id: 2, email: "otro@test.com", createdAt: new Date("2026-01-01") });

    const res = await request(buildApp())
      .put("/api/usuarios/2")
      .set("Authorization", authHeader)
      .send({ password: "clave-nueva-123" });

    expect(res.status).toBe(200);
    const dataPasada = updateMock.mock.calls[0][0].data;
    // Rotar la contraseña invalida todos los JWT emitidos antes del cambio.
    expect(dataPasada.tokenVersion).toEqual({ increment: 1 });
    expect(dataPasada.passwordHash).toBeDefined();
  });

  it("NO incrementa tokenVersion cuando el update es solo de email (cambiar el email no cierra sesiones)", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 2, email: "viejo@test.com", passwordHash: "hash", tokenVersion: 1 });
    findUniqueMock.mockResolvedValueOnce(null); // chequeo de email duplicado
    updateMock.mockResolvedValue({ id: 2, email: "nuevo@test.com", createdAt: new Date("2026-01-01") });

    const res = await request(buildApp())
      .put("/api/usuarios/2")
      .set("Authorization", authHeader)
      .send({ email: "nuevo@test.com" });

    expect(res.status).toBe(200);
    const dataPasada = updateMock.mock.calls[0][0].data;
    expect(dataPasada.tokenVersion).toBeUndefined();
  });
});

describe("DELETE /api/usuarios/:id", () => {
  // El token de la suite es del usuario id 1: los borrados legítimos apuntan
  // a OTRO id, porque el auto-borrado se rechaza (ver el test de abajo).

  it("borra a otro usuario si después del borrado queda al menos un admin", async () => {
    deleteManyMock.mockResolvedValue({ count: 1 });
    countMock.mockResolvedValue(1);

    const res = await request(buildApp()).delete("/api/usuarios/2").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: 2 } });
  });

  it("responde 400 si el borrado dejaría la tabla sin admins (recuento DESPUÉS de borrar, dentro de la transacción)", async () => {
    // El viejo `count()` previo al `delete()` era un TOCTOU: dos DELETE
    // concurrentes con 2 usuarios veían count=2 y dejaban la tabla en 0.
    // Ahora se borra y se recuenta dentro de la misma transacción; si queda
    // cero, se revierte.
    deleteManyMock.mockResolvedValue({ count: 1 });
    countMock.mockResolvedValue(0);

    const res = await request(buildApp()).delete("/api/usuarios/2").set("Authorization", authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("No se puede eliminar el único usuario admin restante.");
    // El recuento tiene que ser POSTERIOR al deleteMany: es lo que lo hace atómico.
    expect(deleteManyMock.mock.invocationCallOrder[0]).toBeLessThan(countMock.mock.invocationCallOrder[0]);
  });

  it("rechaza con 400 que un admin se borre a sí mismo", async () => {
    const res = await request(buildApp()).delete("/api/usuarios/1").set("Authorization", authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("propio usuario");
    expect(deleteManyMock).not.toHaveBeenCalled();
  });

  it("responde 404 si el usuario no existe, sin tirar un 500 de Prisma", async () => {
    deleteManyMock.mockResolvedValue({ count: 0 });

    const res = await request(buildApp()).delete("/api/usuarios/99").set("Authorization", authHeader);

    expect(res.status).toBe(404);
    expect(countMock).not.toHaveBeenCalled();
  });
});

describe("auditoría de usuarios", () => {
  it("registra en AuditLog al crear, con el email pero NUNCA el passwordHash", async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({
      id: 9,
      email: "nuevo@test.com",
      passwordHash: "$2a$10$hash-secreto",
      createdAt: new Date("2026-01-01"),
    });

    await request(buildApp())
      .post("/api/usuarios")
      .set("Authorization", authHeader)
      .send({ email: "nuevo@test.com", password: "clave-secreta" });

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "CREAR",
        entidad: "Usuario",
        entidadId: 9,
        detalle: JSON.stringify({ email: "nuevo@test.com", puedeEliminar: true }),
      }),
    });

    // Ningún secreto puede terminar en la traza: ni el hash ni la clave plana.
    const serializado = JSON.stringify(auditCreateMock.mock.calls);
    expect(serializado).not.toContain("$2a$10$hash-secreto");
    expect(serializado).not.toContain("clave-secreta");
    expect(serializado).not.toContain("passwordHash");
  });

  it("registra en AuditLog al actualizar, indicando si cambió la contraseña sin exponerla", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 1, email: "viejo@test.com", passwordHash: "hash-viejo" });
    updateMock.mockResolvedValue({
      id: 1,
      email: "nuevo@test.com",
      passwordHash: "$2a$10$hash-nuevo",
      createdAt: new Date("2026-01-01"),
    });

    await request(buildApp())
      .put("/api/usuarios/1")
      .set("Authorization", authHeader)
      .send({ email: "nuevo@test.com", password: "clave-nueva" });

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ACTUALIZAR",
        entidad: "Usuario",
        entidadId: 1,
        detalle: JSON.stringify({
          emailAnterior: "viejo@test.com",
          emailNuevo: "nuevo@test.com",
          passwordCambiada: true,
        }),
      }),
    });

    const serializado = JSON.stringify(auditCreateMock.mock.calls);
    expect(serializado).not.toContain("clave-nueva");
    expect(serializado).not.toContain("$2a$10$hash-nuevo");
  });

  it("registra en AuditLog al eliminar", async () => {
    findUniqueMock.mockResolvedValue({ id: 2, email: "borrado@test.com", passwordHash: "hash" });
    deleteManyMock.mockResolvedValue({ count: 1 });
    countMock.mockResolvedValue(1);

    await request(buildApp()).delete("/api/usuarios/2").set("Authorization", authHeader);

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ELIMINAR",
        entidad: "Usuario",
        entidadId: 2,
      }),
    });
  });

  it("NO registra nada en AuditLog al listar (las lecturas no se auditan)", async () => {
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/usuarios").set("Authorization", authHeader);

    expect(auditCreateMock).not.toHaveBeenCalled();
  });
});

describe("permiso de borrado en el CRUD de usuarios", () => {
  it("GET /api/usuarios expone puedeEliminar de cada usuario", async () => {
    findManyMock.mockResolvedValue([
      { id: 1, email: "a@b.c", createdAt: new Date(), puedeEliminar: true },
      { id: 2, email: "d@e.f", createdAt: new Date(), puedeEliminar: false },
    ]);

    const res = await request(buildApp()).get("/api/usuarios").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body[0].puedeEliminar).toBe(true);
    expect(res.body[1].puedeEliminar).toBe(false);
  });

  it("POST /api/usuarios acepta puedeEliminar", async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: 5, email: "n@u.evo", createdAt: new Date(), puedeEliminar: false });

    const res = await request(buildApp())
      .post("/api/usuarios")
      .set("Authorization", authHeader)
      .send({ email: "n@u.evo", password: "unaclavelarga", puedeEliminar: false });

    expect(res.status).toBe(201);
    expect(createMock.mock.calls[0][0].data.puedeEliminar).toBe(false);
  });

  // Sin el campo, un alta hecha por un cliente viejo no puede quedar sin
  // permiso por accidente: el default de la columna es "puede", y esta capa
  // tiene que coincidir con la base.
  it("POST /api/usuarios deja puedeEliminar en true si no viene", async () => {
    findUniqueMock.mockResolvedValue(null);
    createMock.mockResolvedValue({ id: 5, email: "n@u.evo", createdAt: new Date(), puedeEliminar: true });

    await request(buildApp())
      .post("/api/usuarios")
      .set("Authorization", authHeader)
      .send({ email: "n@u.evo", password: "unaclavelarga" });

    expect(createMock.mock.calls[0][0].data.puedeEliminar).toBe(true);
  });

  it("PUT /api/usuarios/:id cambia puedeEliminar", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 2, email: "d@e.f" });
    updateMock.mockResolvedValue({ id: 2, email: "d@e.f", createdAt: new Date(), puedeEliminar: false });

    const res = await request(buildApp())
      .put("/api/usuarios/2")
      .set("Authorization", authHeader)
      .send({ email: "d@e.f", puedeEliminar: false });

    expect(res.status).toBe(200);
    expect(updateMock.mock.calls[0][0].data.puedeEliminar).toBe(false);
  });

  // Omitir el campo en un PUT es "no lo toques", no "ponelo en true": el PUT de
  // esta pantalla se usa para cambiar el email o la contraseña, y no puede
  // devolverle el permiso a alguien de rebote.
  it("PUT /api/usuarios/:id NO toca puedeEliminar si no viene en el body", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 2, email: "d@e.f" });
    findUniqueMock.mockResolvedValueOnce(null); // el email nuevo no está tomado
    updateMock.mockResolvedValue({ id: 2, email: "nuevo@e.f", createdAt: new Date(), puedeEliminar: false });

    await request(buildApp())
      .put("/api/usuarios/2")
      .set("Authorization", authHeader)
      .send({ email: "nuevo@e.f" });

    expect(updateMock.mock.calls[0][0].data).not.toHaveProperty("puedeEliminar");
  });

  // Sacarse el permiso a uno mismo deja la cuenta sin poder revertirlo desde la
  // propia sesión — es el equivalente a borrarse la propia cuenta, que esta
  // pantalla ya impide.
  it("PUT /api/usuarios/:id rechaza que un admin se quite el permiso a sí mismo", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 1, email: "admin@yima.test" });

    const res = await request(buildApp())
      .put("/api/usuarios/1")
      .set("Authorization", authHeader)
      .send({ email: "admin@yima.test", puedeEliminar: false });

    expect(res.status).toBe(400);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
