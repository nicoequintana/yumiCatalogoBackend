import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const findManyMock = vi.fn();
const findUniqueMock = vi.fn();
const createMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const countMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    usuario: {
      findMany: (...args) => findManyMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      create: (...args) => createMock(...args),
      update: (...args) => updateMock(...args),
      delete: (...args) => deleteMock(...args),
      count: (...args) => countMock(...args),
    },
    auditLog: { create: (...args) => auditCreateMock(...args) },
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

const token = jwt.sign({ sub: 1, email: "admin@yima.test" }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  findManyMock.mockReset();
  findUniqueMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  deleteMock.mockReset();
  countMock.mockReset();
  auditCreateMock.mockReset();
  auditCreateMock.mockResolvedValue({ id: 1 });
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
});

describe("DELETE /api/usuarios/:id", () => {
  it("responde 400 si es el único usuario restante", async () => {
    countMock.mockResolvedValue(1);
    const res = await request(buildApp()).delete("/api/usuarios/1").set("Authorization", authHeader);
    expect(res.status).toBe(400);
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("borra si hay más de un usuario", async () => {
    countMock.mockResolvedValue(2);
    deleteMock.mockResolvedValue({});
    const res = await request(buildApp()).delete("/api/usuarios/1").set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 1 } });
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
        detalle: JSON.stringify({ email: "nuevo@test.com" }),
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
    countMock.mockResolvedValue(2);
    findUniqueMock.mockResolvedValue({ id: 2, email: "borrado@test.com", passwordHash: "hash" });
    deleteMock.mockResolvedValue({ id: 2 });

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
