import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import ExcelJS from "exceljs";
import { Decimal } from "@prisma/client/runtime/client.js";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * `GET /api/ordenes/productos-solicitados` — la grilla que agrupa por producto
 * todo lo que los clientes vienen pidiendo, y su exportación a `.xlsx`.
 *
 * Los dos modos de falla que estas pruebas existen para impedir:
 *
 * 1. **Contar las CANCELADAS.** Una orden cancelada no es mercadería a
 *    preparar ni a reponer; sumarla infla el total y hace comprar de más.
 * 2. **Agrupar por `productId` a secas.** Desde que borrar un producto desliga
 *    sus líneas (`onDelete: SetNull`), todos los borrados caen en la clave
 *    `null` y suman sus unidades en una sola fila, bajo el nombre del primero.
 *    Sin error y sin aviso — el mismo agujero que ya cubre
 *    `adminVentas.ranking-eliminados.test.js` para el ranking de facturación.
 */

vi.mock("../middlewares/rateLimit.middleware.js", () => ({
  crearLimitadorDeVelocidad: () => (_req, _res, next) => next(),
}));

vi.mock("../services/notificacionesOrden.service.js", () => ({
  notificarOrdenCreada: vi.fn(),
  notificarCambioEstado: vi.fn(),
}));

const ordenFindManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn() },
    cliente: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    product: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    orden: {
      findMany: (...args) => ordenFindManyMock(...args),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    eventoTrafico: { create: vi.fn() },
  },
}));

const { default: ordenesRouter } = await import("./ordenes.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ordenes", ordenesRouter);
  app.use(manejadorDeErrores);
  return app;
}

const authHeader = `Bearer ${jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" })}`;

function item({ productId = 7, sku = "YIMA-MATE-1234", nombre = "Mate", precio = "100", cantidad = 1 } = {}) {
  return {
    productId,
    nombreProducto: nombre,
    precioUnitario: new Decimal(precio),
    cantidad,
    product: productId === null ? null : { sku },
  };
}

function orden(id, estado, items) {
  return { id, estado, createdAt: new Date("2026-08-20T12:00:00Z"), items };
}

function pedirGrilla() {
  return request(buildApp())
    .get("/api/ordenes/productos-solicitados")
    .set("Authorization", authHeader);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/ordenes/productos-solicitados", () => {
  it("exige autenticacion", async () => {
    const res = await request(buildApp()).get("/api/ordenes/productos-solicitados");

    expect(res.status).toBe(401);
    expect(ordenFindManyMock).not.toHaveBeenCalled();
  });

  it("no matchea la ruta como el id de una orden", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await pedirGrilla();

    // Si Express matcheara `/:id` primero, `obtenerPorId` recibiría
    // "productos-solicitados" como id y respondería 400/404.
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("suma las unidades del mismo producto a traves de varias ordenes", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden(1, "PENDIENTE", [item({ cantidad: 2 })]),
      orden(2, "ENTREGADA", [item({ cantidad: 3 })]),
    ]);

    const res = await pedirGrilla();

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual(
      expect.objectContaining({
        productId: 7,
        sku: "YIMA-MATE-1234",
        nombre: "Mate",
        unidades: 5,
        ordenes: 2,
        facturacion: "500",
      }),
    );
  });

  it("NO cuenta las ordenes canceladas", async () => {
    ordenFindManyMock.mockResolvedValue([orden(1, "PENDIENTE", [item({ cantidad: 2 })])]);

    await pedirGrilla();

    const [args] = ordenFindManyMock.mock.calls[0];
    expect(args.where).toEqual(expect.objectContaining({ estado: { not: "CANCELADA" } }));
  });

  it("incluye las PENDIENTE, que todavia no descontaron stock", async () => {
    ordenFindManyMock.mockResolvedValue([orden(1, "PENDIENTE", [item({ cantidad: 4 })])]);

    const res = await pedirGrilla();

    expect(res.body.data[0].unidades).toBe(4);
  });

  it("no fusiona dos productos borrados distintos en una sola fila", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden(1, "ENTREGADA", [
        item({ productId: null, nombre: "Termo borrado", cantidad: 2 }),
        item({ productId: null, nombre: "Mate borrado", cantidad: 1 }),
      ]),
    ]);

    const res = await pedirGrilla();

    const porNombre = Object.fromEntries(res.body.data.map((p) => [p.nombre, p.unidades]));
    expect(porNombre).toEqual({ "Termo borrado": 2, "Mate borrado": 1 });
  });

  it("emite sku null para el producto borrado", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden(1, "ENTREGADA", [item({ productId: null, nombre: "Termo borrado" })]),
    ]);

    const res = await pedirGrilla();

    expect(res.body.data[0].sku).toBeNull();
    expect(res.body.data[0].productId).toBeNull();
  });

  it("cuenta una sola orden aunque el producto aparezca en dos lineas de ella", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden(1, "CONFIRMADA", [item({ cantidad: 1 }), item({ cantidad: 2 })]),
    ]);

    const res = await pedirGrilla();

    expect(res.body.data[0].unidades).toBe(3);
    expect(res.body.data[0].ordenes).toBe(1);
  });

  it("ordena por unidades descendente", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden(1, "ENTREGADA", [
        item({ productId: 1, sku: "A", nombre: "Poco", cantidad: 1 }),
        item({ productId: 2, sku: "B", nombre: "Mucho", cantidad: 9 }),
        item({ productId: 3, sku: "C", nombre: "Medio", cantidad: 5 }),
      ]),
    ]);

    const res = await pedirGrilla();

    expect(res.body.data.map((p) => p.nombre)).toEqual(["Mucho", "Medio", "Poco"]);
  });

  it("declara el histórico recortado cuando se supera el tope", async () => {
    const { MAX_ORDENES_HISTORICO } = await import("../controllers/admin.controller.js");
    ordenFindManyMock.mockResolvedValue(
      Array.from({ length: MAX_ORDENES_HISTORICO + 1 }, (_, i) =>
        orden(i + 1, "ENTREGADA", [item({ cantidad: 1 })]),
      ),
    );

    const res = await pedirGrilla();

    expect(res.body.historico).toEqual({
      ordenesAnalizadas: MAX_ORDENES_HISTORICO,
      tope: MAX_ORDENES_HISTORICO,
      recortado: true,
    });
    // Se descarta la fila sobrante, no se suma: pedir una de más es cómo se
    // detecta el corte, no un dato del reporte.
    expect(res.body.data[0].unidades).toBe(MAX_ORDENES_HISTORICO);
  });

  it("no declara recorte cuando entra todo", async () => {
    ordenFindManyMock.mockResolvedValue([orden(1, "ENTREGADA", [item()])]);

    const res = await pedirGrilla();

    expect(res.body.historico.recortado).toBe(false);
    expect(res.body.historico.ordenesAnalizadas).toBe(1);
  });
});

describe("GET /api/ordenes/productos-solicitados/export", () => {
  function pedirExport() {
    return request(buildApp())
      .get("/api/ordenes/productos-solicitados/export")
      .set("Authorization", authHeader);
  }

  it("exige autenticacion", async () => {
    const res = await request(buildApp()).get("/api/ordenes/productos-solicitados/export");

    expect(res.status).toBe(401);
  });

  it("responde un .xlsx descargable", async () => {
    ordenFindManyMock.mockResolvedValue([orden(1, "ENTREGADA", [item({ cantidad: 2 })])]);

    const res = await pedirExport();

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(res.headers["content-disposition"]).toContain("productos-solicitados.xlsx");
  });

  it("exporta EXACTAMENTE lo mismo que muestra la grilla", async () => {
    const ordenes = [
      orden(1, "PENDIENTE", [item({ cantidad: 2 })]),
      orden(2, "CANCELADA", [item({ cantidad: 50 })]),
      orden(3, "ENTREGADA", [item({ cantidad: 3 })]),
    ];
    ordenFindManyMock.mockResolvedValue(ordenes);
    const grilla = await pedirGrilla();

    ordenFindManyMock.mockResolvedValue(ordenes);
    const res = await pedirExport().responseType("blob");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const hoja = wb.worksheets[0];

    // Encabezado + una fila por producto de la grilla.
    expect(hoja.rowCount).toBe(grilla.body.data.length + 1);
    const primera = hoja.getRow(2).values.slice(1);
    expect(primera).toEqual([
      grilla.body.data[0].sku,
      grilla.body.data[0].nombre,
      grilla.body.data[0].unidades,
      grilla.body.data[0].ordenes,
      Number(grilla.body.data[0].facturacion),
    ]);
  });
});
