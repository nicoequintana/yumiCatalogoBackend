import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const categoriaMock = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const productCountMock = vi.fn();
const productGroupByMock = vi.fn();
const auditCreateMock = vi.fn();
const txMock = vi.fn();
const subirArchivoMock = vi.fn();
const eliminarArchivoMock = vi.fn();

vi.mock("../services/cloudinary.service.js", () => ({
  subirArchivo: (...args) => subirArchivoMock(...args),
  eliminarArchivo: (...args) => eliminarArchivoMock(...args),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    // `requireAuth` lee la fila del usuario para verificar la revocación de
    // sesión Y el permiso de borrado (`puedeEliminar`). Sin este mock la
    // consulta lanza y el middleware de borrado niega por fail-closed.
    usuario: { findUnique: vi.fn().mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true }) },
    categoria: {
      findMany: (...args) => categoriaMock.findMany(...args),
      findUnique: (...args) => categoriaMock.findUnique(...args),
      create: (...args) => categoriaMock.create(...args),
      update: (...args) => categoriaMock.update(...args),
      delete: (...args) => categoriaMock.delete(...args),
    },
    product: {
      count: (...args) => productCountMock(...args),
      groupBy: (...args) => productGroupByMock(...args),
    },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    $transaction: (...args) => txMock(...args),
  },
}));

const { default: categoriasRouter } = await import("./categorias.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/categorias", categoriasRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
  // El listado hace un groupBy aparte para contar los productos PUBLICADOS de
  // cada categoría; por defecto, ninguna tiene.
  productGroupByMock.mockResolvedValue([]);
  eliminarArchivoMock.mockResolvedValue(undefined);
  // `$transaction` acepta las dos formas que usa el controller: callback (el
  // tope de destacadas, que necesita leer y escribir bajo el mismo aislamiento)
  // y arreglo de operaciones (la reescritura del orden).
  txMock.mockImplementation(async (arg) => {
    if (typeof arg === "function") {
      return arg({ categoria: categoriaMock });
    }
    return Promise.all(arg);
  });
});

describe("GET /api/categorias (público)", () => {
  it("responde 200 SIN token — el listado lo consume la página pública /coleccion", async () => {
    categoriaMock.findMany.mockResolvedValue([
      { id: 1, nombre: "Velas", _count: { productos: 3 } },
    ]);

    const res = await request(buildApp()).get("/api/categorias");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 1, nombre: "Velas", cantidadProductos: 3, cantidadPublicados: 0, imagenUrl: null, destacadaEnHome: false, ordenHome: 0 },
    ]);
  });
});

describe("POST /api/categorias (protegido)", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).post("/api/categorias").send({ nombre: "Velas" });

    expect(res.status).toBe(401);
    expect(categoriaMock.create).not.toHaveBeenCalled();
  });

  it("responde 201 con token válido", async () => {
    categoriaMock.findUnique.mockResolvedValue(null);
    categoriaMock.create.mockResolvedValue({ id: 5, nombre: "Velas", _count: { productos: 0 } });

    const res = await request(buildApp())
      .post("/api/categorias")
      .set("Authorization", authHeader)
      .send({ nombre: "Velas" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 5, nombre: "Velas", cantidadProductos: 0, imagenUrl: null, destacadaEnHome: false, ordenHome: 0 });
  });
});

describe("PUT /api/categorias/:id (protegido)", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).put("/api/categorias/1").send({ nombre: "Nuevo" });

    expect(res.status).toBe(401);
    expect(categoriaMock.update).not.toHaveBeenCalled();
  });

  it("responde 200 con token válido", async () => {
    categoriaMock.findUnique.mockResolvedValueOnce({ id: 1, nombre: "Velas" });
    categoriaMock.update.mockResolvedValue({ id: 1, nombre: "Aromas", _count: { productos: 2 } });

    const res = await request(buildApp())
      .put("/api/categorias/1")
      .set("Authorization", authHeader)
      .send({ nombre: "Aromas" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 1, nombre: "Aromas", cantidadProductos: 2, imagenUrl: null, destacadaEnHome: false, ordenHome: 0 });
  });
});

describe("DELETE /api/categorias/:id (protegido)", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).delete("/api/categorias/1");

    expect(res.status).toBe(401);
    expect(categoriaMock.delete).not.toHaveBeenCalled();
  });

  it("responde 200 con token válido", async () => {
    categoriaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Velas" });
    productCountMock.mockResolvedValue(0);
    categoriaMock.delete.mockResolvedValue({ id: 1 });

    const res = await request(buildApp())
      .delete("/api/categorias/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("auditoría de categorías", () => {
  it("registra en AuditLog al crear", async () => {
    categoriaMock.findUnique.mockResolvedValue(null);
    categoriaMock.create.mockResolvedValue({ id: 5, nombre: "Velas", _count: { productos: 0 } });

    await request(buildApp())
      .post("/api/categorias")
      .set("Authorization", authHeader)
      .send({ nombre: "Velas" });

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "CREAR",
        entidad: "Categoria",
        entidadId: 5,
        usuarioEmail: "admin@yima.test",
      }),
    });
  });

  it("registra en AuditLog al actualizar, con el nombre anterior y el nuevo", async () => {
    categoriaMock.findUnique.mockResolvedValueOnce({ id: 1, nombre: "Velas" });
    categoriaMock.update.mockResolvedValue({ id: 1, nombre: "Aromas", _count: { productos: 2 } });

    await request(buildApp())
      .put("/api/categorias/1")
      .set("Authorization", authHeader)
      .send({ nombre: "Aromas" });

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ACTUALIZAR",
        entidad: "Categoria",
        entidadId: 1,
        detalle: JSON.stringify({ nombreAnterior: "Velas", nombreNuevo: "Aromas" }),
      }),
    });
  });

  it("registra en AuditLog al eliminar", async () => {
    categoriaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Velas" });
    productCountMock.mockResolvedValue(0);
    categoriaMock.delete.mockResolvedValue({ id: 1 });

    await request(buildApp()).delete("/api/categorias/1").set("Authorization", authHeader);

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ELIMINAR",
        entidad: "Categoria",
        entidadId: 1,
        detalle: JSON.stringify({ nombre: "Velas" }),
      }),
    });
  });

  it("NO registra nada en AuditLog en el listado (las lecturas no se auditan)", async () => {
    categoriaMock.findMany.mockResolvedValue([]);

    await request(buildApp()).get("/api/categorias");

    expect(auditCreateMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/categorias — cantidadPublicados", () => {
  it("cuenta aparte los productos que un visitante realmente ve", async () => {
    // `cantidadProductos` cuenta TODO (ocultos y agotados incluidos) porque el
    // panel lo usa para decidir si una categoría se puede borrar. La home
    // rankea con `cantidadPublicados`: sin ese segundo número, podía destacar
    // una categoría cuyos productos están todos ocultos y mandar al visitante
    // a una grilla vacía, sin ningún error.
    categoriaMock.findMany.mockResolvedValue([
      { id: 1, nombre: "Cocina", _count: { productos: 10 } },
      { id: 2, nombre: "Hogar", _count: { productos: 4 } },
    ]);
    productGroupByMock.mockResolvedValue([{ categoriaId: 1, _count: { _all: 3 } }]);

    const res = await request(buildApp()).get("/api/categorias");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: 1, nombre: "Cocina", cantidadProductos: 10, cantidadPublicados: 3, imagenUrl: null, destacadaEnHome: false, ordenHome: 0 },
      // Sin fila en el groupBy = cero publicados, no "sin dato".
      { id: 2, nombre: "Hogar", cantidadProductos: 4, cantidadPublicados: 0, imagenUrl: null, destacadaEnHome: false, ordenHome: 0 },
    ]);
  });

  it("cuenta sólo lo visible y con stock, y descarta los productos sin categoría", async () => {
    categoriaMock.findMany.mockResolvedValue([]);

    await request(buildApp()).get("/api/categorias");

    expect(productGroupByMock).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["categoriaId"],
        where: {
          visibleEnCatalogo: true,
          stock: { gt: 0 },
          categoriaId: { not: null },
        },
      }),
    );
  });

  it("crear NO emite cantidadPublicados: un 0 se leería como dato, y es «no lo sé»", async () => {
    categoriaMock.findUnique.mockResolvedValue(null);
    categoriaMock.create.mockResolvedValue({ id: 9, nombre: "Nueva", _count: { productos: 0 } });

    const res = await request(buildApp())
      .post("/api/categorias")
      .set("Authorization", authHeader)
      .send({ nombre: "Nueva" });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("cantidadPublicados");
  });
});
