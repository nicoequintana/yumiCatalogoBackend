import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const etiquetaMock = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const productCountMock = vi.fn();
const usuarioFindUniqueMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    etiqueta: {
      findMany: (...args) => etiquetaMock.findMany(...args),
      findUnique: (...args) => etiquetaMock.findUnique(...args),
      create: (...args) => etiquetaMock.create(...args),
      update: (...args) => etiquetaMock.update(...args),
      delete: (...args) => etiquetaMock.delete(...args),
    },
    product: { count: (...args) => productCountMock(...args) },
    usuario: { findUnique: (...args) => usuarioFindUniqueMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
  },
}));

const { default: etiquetasRouter } = await import("./etiquetas.routes.js");
const { LARGO_MAX_ETIQUETA } = await import("../controllers/etiquetas.controller.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/etiquetas", etiquetasRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "7d",
});
const authHeader = `Bearer ${token}`;

const FILA = { id: 1, nombre: "Nuevo", color: "VERDE", _count: { productos: 3 } };

beforeEach(() => {
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
  etiquetaMock.findMany.mockResolvedValue([FILA]);
  productCountMock.mockResolvedValue(0);
});

describe("GET /api/etiquetas", () => {
  it("sin token responde 401", async () => {
    const res = await request(buildApp()).get("/api/etiquetas");
    expect(res.status).toBe(401);
  });

  it("emite el color RESUELTO en canales y el conteo de productos", async () => {
    const res = await request(buildApp()).get("/api/etiquetas").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: 1,
        nombre: "Nuevo",
        color: "VERDE",
        colorFondo: "46 125 50",
        colorTexto: "255 255 255",
        cantidadProductos: 3,
      },
    ]);
  });

  it("una etiqueta sin color emite colorFondo y colorTexto en null", async () => {
    etiquetaMock.findMany.mockResolvedValue([{ ...FILA, color: null }]);

    const res = await request(buildApp()).get("/api/etiquetas").set("Authorization", authHeader);

    expect(res.body[0].colorFondo).toBeNull();
    expect(res.body[0].colorTexto).toBeNull();
  });
});

describe("GET /api/etiquetas/opciones", () => {
  it("NO se confunde con la ruta por id", async () => {
    const res = await request(buildApp())
      .get("/api/etiquetas/opciones")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.colores).toHaveLength(20);
    expect(etiquetaMock.findUnique).not.toHaveBeenCalled();
  });

  it("emite cada color con id, nombre, fondo y texto", async () => {
    const res = await request(buildApp())
      .get("/api/etiquetas/opciones")
      .set("Authorization", authHeader);

    expect(res.body.colores[0]).toEqual({
      id: "TERRACOTA",
      nombre: "Terracota",
      fondo: "157 62 29",
      texto: "255 255 255",
    });
  });
});

describe("POST /api/etiquetas", () => {
  it("sin token responde 401", async () => {
    const res = await request(buildApp()).post("/api/etiquetas").send({ nombre: "Oferta" });
    expect(res.status).toBe(401);
  });

  it("crea y responde 201 con la fila mapeada", async () => {
    etiquetaMock.create.mockResolvedValue({ id: 7, nombre: "Oferta", color: "ROJO" });

    const res = await request(buildApp())
      .post("/api/etiquetas")
      .set("Authorization", authHeader)
      .send({ nombre: "  Oferta  ", color: "ROJO" });

    expect(res.status).toBe(201);
    expect(etiquetaMock.create).toHaveBeenCalledWith({
      data: { nombre: "Oferta", color: "ROJO" },
      include: { _count: { select: { productos: true } } },
    });
    expect(res.body).toEqual({
      id: 7,
      nombre: "Oferta",
      color: "ROJO",
      colorFondo: "186 26 26",
      colorTexto: "255 255 255",
      cantidadProductos: 0,
    });
  });

  it("rechaza nombre vacío", async () => {
    const res = await request(buildApp())
      .post("/api/etiquetas")
      .set("Authorization", authHeader)
      .send({ nombre: "   " });

    expect(res.status).toBe(400);
    expect(etiquetaMock.create).not.toHaveBeenCalled();
  });

  it("rechaza un nombre más largo que el tope, y el mensaje DICE el límite", async () => {
    const res = await request(buildApp())
      .post("/api/etiquetas")
      .set("Authorization", authHeader)
      .send({ nombre: "x".repeat(LARGO_MAX_ETIQUETA + 1) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(String(LARGO_MAX_ETIQUETA));
  });

  it("rechaza un color que no está en la paleta", async () => {
    const res = await request(buildApp())
      .post("/api/etiquetas")
      .set("Authorization", authHeader)
      .send({ nombre: "Oferta", color: "#ff0000" });

    expect(res.status).toBe(400);
    expect(etiquetaMock.create).not.toHaveBeenCalled();
  });

  // Sin esto el P2002 sale como 500 opaco y el admin lee "error del servidor"
  // cuando en realidad tipeó un nombre que ya existe.
  it("traduce el nombre repetido a un 400 con mensaje propio", async () => {
    etiquetaMock.create.mockRejectedValue({ code: "P2002" });

    const res = await request(buildApp())
      .post("/api/etiquetas")
      .set("Authorization", authHeader)
      .send({ nombre: "Nuevo" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Nuevo");
  });

  // Bug de la review final: `create` no llevaba el `include` del conteo, así
  // que una etiqueta creada con productos ya asociados (p.ej. por una carga
  // en simultáneo) respondía `cantidadProductos: 0` mintiendo. Mismo criterio
  // que `cantidadFotos`: lo tienen que emitir los dos mappers.
  it("el create pide el conteo de productos, y la respuesta lo refleja", async () => {
    etiquetaMock.create.mockResolvedValue({
      id: 7,
      nombre: "Oferta",
      color: "ROJO",
      _count: { productos: 8 },
    });

    const res = await request(buildApp())
      .post("/api/etiquetas")
      .set("Authorization", authHeader)
      .send({ nombre: "Oferta", color: "ROJO" });

    expect(etiquetaMock.create).toHaveBeenCalledWith({
      data: { nombre: "Oferta", color: "ROJO" },
      include: { _count: { select: { productos: true } } },
    });
    expect(res.body.cantidadProductos).toBe(8);
  });

  it("audita la creación", async () => {
    etiquetaMock.create.mockResolvedValue({ id: 7, nombre: "Oferta", color: null });

    await request(buildApp())
      .post("/api/etiquetas")
      .set("Authorization", authHeader)
      .send({ nombre: "Oferta" });

    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accion: "CREAR", entidad: "Etiqueta", entidadId: 7 }),
      }),
    );
  });
});

describe("PUT /api/etiquetas/:id", () => {
  it("404 cuando no existe", async () => {
    etiquetaMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .put("/api/etiquetas/99")
      .set("Authorization", authHeader)
      .send({ nombre: "Otra" });

    expect(res.status).toBe(404);
  });

  it("acepta color: null explícito para volver al color por defecto", async () => {
    etiquetaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Nuevo", color: "VERDE" });
    etiquetaMock.update.mockResolvedValue({ id: 1, nombre: "Nuevo", color: null });

    const res = await request(buildApp())
      .put("/api/etiquetas/1")
      .set("Authorization", authHeader)
      .send({ color: null });

    expect(res.status).toBe(200);
    expect(etiquetaMock.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { nombre: undefined, color: null },
      include: { _count: { select: { productos: true } } },
    });
    expect(res.body.colorFondo).toBeNull();
  });

  it("una clave ausente NO se toca", async () => {
    etiquetaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Nuevo", color: "VERDE" });
    etiquetaMock.update.mockResolvedValue({ id: 1, nombre: "Novedad", color: "VERDE" });

    await request(buildApp())
      .put("/api/etiquetas/1")
      .set("Authorization", authHeader)
      .send({ nombre: "Novedad" });

    expect(etiquetaMock.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { nombre: "Novedad", color: undefined },
      include: { _count: { select: { productos: true } } },
    });
  });

  it("el update pide el conteo de productos, y la respuesta lo refleja", async () => {
    etiquetaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Nuevo", color: "VERDE" });
    etiquetaMock.update.mockResolvedValue({
      id: 1,
      nombre: "Nuevo",
      color: "ROJO",
      _count: { productos: 8 },
    });

    const res = await request(buildApp())
      .put("/api/etiquetas/1")
      .set("Authorization", authHeader)
      .send({ color: "ROJO" });

    expect(etiquetaMock.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { nombre: undefined, color: "ROJO" },
      include: { _count: { select: { productos: true } } },
    });
    expect(res.body.cantidadProductos).toBe(8);
  });

  it("400 cuando no viene ni nombre ni color", async () => {
    etiquetaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Nuevo", color: null });

    const res = await request(buildApp())
      .put("/api/etiquetas/1")
      .set("Authorization", authHeader)
      .send({});

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/etiquetas/:id", () => {
  it("bloquea el borrado si hay productos usándola, y el mensaje dice cuántos", async () => {
    etiquetaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Nuevo", color: null });
    productCountMock.mockResolvedValue(4);

    const res = await request(buildApp())
      .delete("/api/etiquetas/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("4");
    expect(etiquetaMock.delete).not.toHaveBeenCalled();
  });

  it("borra cuando no la usa nadie", async () => {
    etiquetaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Nuevo", color: null });
    productCountMock.mockResolvedValue(0);
    etiquetaMock.delete.mockResolvedValue({ id: 1 });

    const res = await request(buildApp())
      .delete("/api/etiquetas/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accion: "ELIMINAR", entidad: "Etiqueta" }),
      }),
    );
  });

  it("403 si el usuario no tiene permiso de borrado", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: false });

    const res = await request(buildApp())
      .delete("/api/etiquetas/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(403);
  });
});
