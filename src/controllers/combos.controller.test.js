import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const comboMock = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const comboItemMock = { deleteMany: vi.fn(), createMany: vi.fn() };
const productMock = { findMany: vi.fn() };
const usuarioFindUniqueMock = vi.fn();
const auditCreateMock = vi.fn();
const transactionMock = vi.fn((fn) => fn({ comboItem: comboItemMock, combo: comboMock }));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    combo: {
      findMany: (...a) => comboMock.findMany(...a),
      findUnique: (...a) => comboMock.findUnique(...a),
      findFirst: (...a) => comboMock.findFirst(...a),
      create: (...a) => comboMock.create(...a),
      update: (...a) => comboMock.update(...a),
      delete: (...a) => comboMock.delete(...a),
    },
    comboItem: {
      deleteMany: (...a) => comboItemMock.deleteMany(...a),
      createMany: (...a) => comboItemMock.createMany(...a),
    },
    product: { findMany: (...a) => productMock.findMany(...a) },
    usuario: { findUnique: (...a) => usuarioFindUniqueMock(...a) },
    auditLog: { create: (...a) => auditCreateMock(...a) },
    $transaction: (...a) => transactionMock(...a),
  },
}));

const { default: combosRouter } = await import("../routes/combos.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/combos", combosRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "3650d",
});
const authHeader = `Bearer ${token}`;

function fila(extra = {}) {
  return {
    id: 1,
    nombre: "Kit Living Cálido",
    frase: "Luz suave y una mesa de roble.",
    porcentaje: 15,
    activo: false,
    vigencia: "SIEMPRE",
    heroUrl: null,
    heroCloudinaryPublicId: null,
    heroCloudinaryResourceType: null,
    vistas: 0,
    items: [
      { productId: 1, cantidad: 2, product: { id: 1, sku: "LAM-01", nombre: "Lámpara", precio: 10000, stock: 9 } },
      { productId: 2, cantidad: 1, product: { id: 2, sku: "MES-01", nombre: "Mesa", precio: 25000, stock: 4 } },
    ],
    campanias: [],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
  transactionMock.mockImplementation((fn) => fn({ comboItem: comboItemMock, combo: comboMock }));
});

describe("GET /combos/admin/combos", () => {
  it("401 sin token", async () => {
    const res = await request(buildApp()).get("/api/combos/admin/combos");
    expect(res.status).toBe(401);
  });

  it("lista los combos con sus productos", async () => {
    comboMock.findMany.mockResolvedValue([fila()]);
    const res = await request(buildApp())
      .get("/api/combos/admin/combos")
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(res.body[0].nombre).toBe("Kit Living Cálido");
    expect(res.body[0].precioCombo).toBe("38250");
  });
});

describe("POST /combos/admin/combos", () => {
  it("crea un combo válido, nace apagado", async () => {
    productMock.findMany.mockResolvedValue([
      { id: 1 },
      { id: 2 },
    ]);
    comboMock.create.mockResolvedValue(fila());

    const res = await request(buildApp())
      .post("/api/combos/admin/combos")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit Living Cálido",
        frase: "Luz suave y una mesa de roble.",
        porcentaje: 15,
        items: [{ productId: 1, cantidad: 2 }, { productId: 2, cantidad: 1 }],
      });

    expect(res.status).toBe(201);
    expect(comboMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activo: false, nombre: "Kit Living Cálido" }),
      }),
    );
  });

  it("400 con menos de 2 unidades", async () => {
    const res = await request(buildApp())
      .post("/api/combos/admin/combos")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit",
        frase: "Frase.",
        porcentaje: 15,
        items: [{ productId: 1, cantidad: 1 }],
      });
    expect(res.status).toBe(400);
  });

  it("400 con un porcentaje fuera de rango", async () => {
    const res = await request(buildApp())
      .post("/api/combos/admin/combos")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit",
        frase: "Frase.",
        porcentaje: 51,
        items: [{ productId: 1, cantidad: 1 }, { productId: 2, cantidad: 1 }],
      });
    expect(res.status).toBe(400);
  });

  it("400 sin nombre", async () => {
    const res = await request(buildApp())
      .post("/api/combos/admin/combos")
      .set("Authorization", authHeader)
      .send({
        frase: "Frase.",
        porcentaje: 15,
        items: [{ productId: 1, cantidad: 1 }, { productId: 2, cantidad: 1 }],
      });
    expect(res.status).toBe(400);
  });
});

describe("PUT /combos/admin/combos/:id", () => {
  it("reemplaza la lista completa de items", async () => {
    comboMock.findUnique.mockResolvedValue(fila());
    productMock.findMany.mockResolvedValue([{ id: 1 }, { id: 3 }]);
    comboMock.update.mockResolvedValue(fila({ items: [] }));

    const res = await request(buildApp())
      .put("/api/combos/admin/combos/1")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit Living Cálido",
        frase: "Luz suave y una mesa de roble.",
        porcentaje: 20,
        items: [{ productId: 1, cantidad: 1 }, { productId: 3, cantidad: 1 }],
      });

    expect(res.status).toBe(200);
    expect(comboItemMock.deleteMany).toHaveBeenCalledWith({ where: { comboId: 1 } });
    expect(comboItemMock.createMany).toHaveBeenCalledWith({
      data: [
        { comboId: 1, productId: 1, cantidad: 1 },
        { comboId: 1, productId: 3, cantidad: 1 },
      ],
    });
    // La edición de la fila va en la MISMA transacción que el reemplazo de items.
    expect(comboMock.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, data: expect.objectContaining({ porcentaje: 20 }) }),
    );
  });

  it("400 al activar un combo sin imagen principal, sin tocar la base", async () => {
    comboMock.findUnique.mockResolvedValue(fila({ heroUrl: null }));

    const res = await request(buildApp())
      .put("/api/combos/admin/combos/1")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit Living Cálido",
        frase: "Luz suave y una mesa de roble.",
        porcentaje: 15,
        activo: true,
        items: [{ productId: 1, cantidad: 2 }, { productId: 2, cantidad: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Para activar el combo primero cargá la imagen principal.");
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("activa un combo que ya tiene imagen principal", async () => {
    comboMock.findUnique.mockResolvedValue(fila({ heroUrl: "https://res.cloudinary.com/x/hero.jpg" }));
    productMock.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    comboMock.update.mockResolvedValue(fila({ activo: true, heroUrl: "https://res.cloudinary.com/x/hero.jpg" }));

    const res = await request(buildApp())
      .put("/api/combos/admin/combos/1")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit Living Cálido",
        frase: "Luz suave y una mesa de roble.",
        porcentaje: 15,
        activo: true,
        items: [{ productId: 1, cantidad: 2 }, { productId: 2, cantidad: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.activo).toBe(true);
  });

  it("404 si el combo no existe", async () => {
    comboMock.findUnique.mockResolvedValue(null);
    const res = await request(buildApp())
      .put("/api/combos/admin/combos/999")
      .set("Authorization", authHeader)
      .send({ nombre: "X", frase: "Y", porcentaje: 10, items: [] });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /combos/admin/combos/:id", () => {
  it("403 sin permiso de borrado", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: false });
    comboMock.findUnique.mockResolvedValue(fila());
    const res = await request(buildApp())
      .delete("/api/combos/admin/combos/1")
      .set("Authorization", authHeader);
    expect(res.status).toBe(403);
  });

  it("borra el combo", async () => {
    comboMock.findUnique.mockResolvedValue(fila());
    comboMock.delete.mockResolvedValue({});
    const res = await request(buildApp())
      .delete("/api/combos/admin/combos/1")
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
  });
});
