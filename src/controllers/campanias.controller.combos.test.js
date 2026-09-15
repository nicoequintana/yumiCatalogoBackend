import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const campaniaMock = { findUnique: vi.fn() };
const comboMock = { findMany: vi.fn() };
const campaniaComboMock = { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() };
const usuarioFindUniqueMock = vi.fn();
const auditCreateMock = vi.fn();
const transactionMock = vi.fn((fn) => fn({ campaniaCombo: campaniaComboMock }));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    campania: { findUnique: (...a) => campaniaMock.findUnique(...a) },
    combo: { findMany: (...a) => comboMock.findMany(...a) },
    campaniaCombo: {
      deleteMany: (...a) => campaniaComboMock.deleteMany(...a),
      createMany: (...a) => campaniaComboMock.createMany(...a),
      findMany: (...a) => campaniaComboMock.findMany(...a),
    },
    usuario: { findUnique: (...a) => usuarioFindUniqueMock(...a) },
    auditLog: { create: (...a) => auditCreateMock(...a) },
    $transaction: (...a) => transactionMock(...a),
  },
}));

const { default: campaniasRouter } = await import("../routes/campanias.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/campanias", campaniasRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "3650d",
});
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  vi.clearAllMocks();
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
  campaniaMock.findUnique.mockResolvedValue({ id: 7, nombre: "Navidad" });
});

describe("PUT /campanias/:id/combos", () => {
  it("reemplaza la lista completa", async () => {
    comboMock.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    campaniaComboMock.findMany.mockResolvedValue([{ comboId: 1 }, { comboId: 2 }]);

    const res = await request(buildApp())
      .put("/api/campanias/7/combos")
      .set("Authorization", authHeader)
      .send({ comboIds: [1, 2] });

    expect(res.status).toBe(200);
    expect(campaniaComboMock.deleteMany).toHaveBeenCalledWith({ where: { campaniaId: 7 } });
    expect(res.body.comboIds).toEqual([1, 2]);
  });

  it("400 con un combo repetido", async () => {
    const res = await request(buildApp())
      .put("/api/campanias/7/combos")
      .set("Authorization", authHeader)
      .send({ comboIds: [1, 1] });
    expect(res.status).toBe(400);
  });

  it("400 con un id de combo fuera de rango seguro (1e21), sin consultar combos", async () => {
    const res = await request(buildApp())
      .put("/api/campanias/7/combos")
      .set("Authorization", authHeader)
      .send({ comboIds: [1e21] });
    expect(res.status).toBe(400);
    expect(comboMock.findMany).not.toHaveBeenCalled();
  });

  it("400 con un combo que ya no existe", async () => {
    comboMock.findMany.mockResolvedValue([{ id: 1 }]);
    const res = await request(buildApp())
      .put("/api/campanias/7/combos")
      .set("Authorization", authHeader)
      .send({ comboIds: [1, 99] });
    expect(res.status).toBe(400);
  });
});
