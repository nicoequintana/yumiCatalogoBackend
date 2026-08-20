import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const eventoGroupByMock = vi.fn();
const eventoCountMock = vi.fn();
const ordenCountMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    errorLog: { findMany: vi.fn(), count: vi.fn() },
    auditLog: { findMany: vi.fn(), count: vi.fn() },
    orden: {
      findMany: vi.fn(async () => []),
      count: (...args) => ordenCountMock(...args),
    },
    eventoTrafico: {
      groupBy: (...args) => eventoGroupByMock(...args),
      count: (...args) => eventoCountMock(...args),
    },
  },
}));

const { default: adminRouter } = await import("./admin.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

/**
 * El controller hace tres `groupBy` distintos sobre `eventoTrafico`:
 *  - por `tipo` con `_min: { createdAt } }` → arranque de registro de cada etapa
 *  - por `tipo` con `_count` acotado al período → conteos de etapa
 *  - por `referrer` con `_count` acotado al período → fuentes de tráfico
 *
 * Este helper enruta cada llamada al fixture correcto mirando la forma del
 * argumento, para que los tests declaren datos y no orden de invocación.
 */
function mockEventos({ arranques = [], conteos = [], referrers = [] } = {}) {
  eventoGroupByMock.mockImplementation(async (args) => {
    if (args._min) return arranques;
    if (Array.isArray(args.by) ? args.by.includes("referrer") : args.by === "referrer") {
      return referrers;
    }
    return conteos;
  });
}

beforeEach(() => {
  eventoGroupByMock.mockReset();
  eventoCountMock.mockReset();
  ordenCountMock.mockReset();
  mockEventos();
  ordenCountMock.mockResolvedValue(0);
});

describe("GET /api/admin/embudo", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/admin/embudo");
    expect(res.status).toBe(401);
  });

  it("devuelve los cuatro conteos de etapa del período", async () => {
    mockEventos({
      arranques: [
        { tipo: "VISTA_PRODUCTO", _min: { createdAt: new Date("2026-08-01T00:00:00.000Z") } },
        { tipo: "AGREGADO_CARRITO", _min: { createdAt: new Date("2026-08-01T00:00:00.000Z") } },
        { tipo: "ORDEN_CREADA", _min: { createdAt: new Date("2026-08-01T00:00:00.000Z") } },
      ],
      conteos: [
        { tipo: "VISTA_PRODUCTO", _count: { _all: 1000 } },
        { tipo: "AGREGADO_CARRITO", _count: { _all: 200 } },
        { tipo: "ORDEN_CREADA", _count: { _all: 50 } },
      ],
    });
    ordenCountMock.mockResolvedValue(25);

    const res = await request(buildApp())
      .get("/api/admin/embudo?desde=2026-08-05&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.etapas.map((etapa) => etapa.clave)).toEqual([
      "VISTAS",
      "CARRITO",
      "ORDENES_CREADAS",
      "ORDENES_CONFIRMADAS",
    ]);
    expect(res.body.etapas.map((etapa) => etapa.cantidad)).toEqual([1000, 200, 50, 25]);
  });

  it("cuenta las órdenes confirmadas con los mismos estados facturables del dashboard de ventas", async () => {
    ordenCountMock.mockResolvedValue(7);

    await request(buildApp())
      .get("/api/admin/embudo?desde=2026-08-05&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(ordenCountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          estado: { in: ["CONFIRMADA", "EN_PREPARACION", "ENTREGADA"] },
        }),
      }),
    );
  });

  it("calcula las tasas de conversión entre etapas consecutivas y la global", async () => {
    mockEventos({
      arranques: [
        { tipo: "VISTA_PRODUCTO", _min: { createdAt: new Date("2026-08-01T00:00:00.000Z") } },
        { tipo: "AGREGADO_CARRITO", _min: { createdAt: new Date("2026-08-01T00:00:00.000Z") } },
        { tipo: "ORDEN_CREADA", _min: { createdAt: new Date("2026-08-01T00:00:00.000Z") } },
      ],
      conteos: [
        { tipo: "VISTA_PRODUCTO", _count: { _all: 1000 } },
        { tipo: "AGREGADO_CARRITO", _count: { _all: 200 } },
        { tipo: "ORDEN_CREADA", _count: { _all: 50 } },
      ],
    });
    ordenCountMock.mockResolvedValue(25);

    const res = await request(buildApp())
      .get("/api/admin/embudo?desde=2026-08-05&hasta=2026-08-15")
      .set("Authorization", authHeader);

    // Primera etapa no tiene etapa previa: su tasa es null, no 100%.
    expect(res.body.etapas[0].tasaDesdeAnterior).toBeNull();
    expect(res.body.etapas[1].tasaDesdeAnterior).toBe(0.2);
    expect(res.body.etapas[2].tasaDesdeAnterior).toBe(0.25);
    expect(res.body.etapas[3].tasaDesdeAnterior).toBe(0.5);
    expect(res.body.tasaGlobal).toBe(0.025);
  });

  it("marca la tasa como no calculable en vez de devolver más de 100%", async () => {
    // El caso real: los emisores se cablearon en momentos distintos, así que
    // hay 1 vista y 72 agregados al carrito. 7200% sería basura.
    mockEventos({
      arranques: [
        { tipo: "VISTA_PRODUCTO", _min: { createdAt: new Date("2026-08-19T00:00:00.000Z") } },
        { tipo: "AGREGADO_CARRITO", _min: { createdAt: new Date("2026-08-18T00:00:00.000Z") } },
        { tipo: "ORDEN_CREADA", _min: { createdAt: new Date("2026-08-18T00:00:00.000Z") } },
      ],
      conteos: [
        { tipo: "VISTA_PRODUCTO", _count: { _all: 1 } },
        { tipo: "AGREGADO_CARRITO", _count: { _all: 72 } },
        { tipo: "ORDEN_CREADA", _count: { _all: 45 } },
      ],
    });
    ordenCountMock.mockResolvedValue(10);

    const res = await request(buildApp())
      .get("/api/admin/embudo?desde=2026-08-01&hasta=2026-08-19")
      .set("Authorization", authHeader);

    expect(res.body.etapas[1].tasaDesdeAnterior).toBeNull();
    expect(res.body.etapas[1].tasaCalculable).toBe(false);
    // ORDENES_CREADAS (45) sí es menor que CARRITO (72): esa sí se calcula.
    expect(res.body.etapas[2].tasaCalculable).toBe(true);
    // La global compara la última etapa contra la primera: 10 > 1, no calculable.
    expect(res.body.tasaGlobal).toBeNull();
    expect(res.body.tasaGlobalCalculable).toBe(false);
  });

  it("deriva confiableDesde como la más tardía de las fechas de arranque por etapa", async () => {
    mockEventos({
      arranques: [
        { tipo: "AGREGADO_CARRITO", _min: { createdAt: new Date("2026-08-18T18:14:00.000Z") } },
        { tipo: "ORDEN_CREADA", _min: { createdAt: new Date("2026-08-18T18:14:00.000Z") } },
        { tipo: "VISTA_PRODUCTO", _min: { createdAt: new Date("2026-08-19T17:28:00.000Z") } },
        { tipo: "COMPARTIDO", _min: { createdAt: new Date("2026-08-19T17:28:00.000Z") } },
      ],
    });

    const res = await request(buildApp())
      .get("/api/admin/embudo?desde=2026-08-01&hasta=2026-08-19")
      .set("Authorization", authHeader);

    expect(res.body.confiableDesde).toBe("2026-08-19");
    expect(res.body.periodoConfiable).toBe(false);
  });

  it("marca cada etapa cuyo registro arrancó después del inicio del período", async () => {
    mockEventos({
      arranques: [
        { tipo: "AGREGADO_CARRITO", _min: { createdAt: new Date("2026-08-18T18:14:00.000Z") } },
        { tipo: "ORDEN_CREADA", _min: { createdAt: new Date("2026-08-18T18:14:00.000Z") } },
        { tipo: "VISTA_PRODUCTO", _min: { createdAt: new Date("2026-08-19T17:28:00.000Z") } },
      ],
    });

    const res = await request(buildApp())
      .get("/api/admin/embudo?desde=2026-08-18&hasta=2026-08-19")
      .set("Authorization", authHeader);

    const porClave = Object.fromEntries(res.body.etapas.map((etapa) => [etapa.clave, etapa]));

    expect(porClave.VISTAS.registraDesde).toBe("2026-08-19");
    expect(porClave.VISTAS.subregistrada).toBe(true);

    expect(porClave.CARRITO.registraDesde).toBe("2026-08-18");
    expect(porClave.CARRITO.subregistrada).toBe(false);

    expect(porClave.ORDENES_CREADAS.subregistrada).toBe(false);
  });

  it("marca el período como confiable cuando arranca después de confiableDesde", async () => {
    mockEventos({
      arranques: [
        { tipo: "AGREGADO_CARRITO", _min: { createdAt: new Date("2026-08-18T18:14:00.000Z") } },
        { tipo: "ORDEN_CREADA", _min: { createdAt: new Date("2026-08-18T18:14:00.000Z") } },
        { tipo: "VISTA_PRODUCTO", _min: { createdAt: new Date("2026-08-19T17:28:00.000Z") } },
      ],
    });

    const res = await request(buildApp())
      .get("/api/admin/embudo?desde=2026-08-19&hasta=2026-08-19")
      .set("Authorization", authHeader);

    expect(res.body.periodoConfiable).toBe(true);
    expect(res.body.etapas.every((etapa) => etapa.subregistrada === false)).toBe(true);
  });

  it("un período sin datos devuelve ceros, no NaN ni null en los conteos", async () => {
    mockEventos();
    ordenCountMock.mockResolvedValue(0);

    const res = await request(buildApp())
      .get("/api/admin/embudo?desde=2026-08-01&hasta=2026-08-10")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.etapas.map((etapa) => etapa.cantidad)).toEqual([0, 0, 0, 0]);
    // Sin vistas no hay denominador: la tasa es null (no calculable), nunca NaN.
    for (const etapa of res.body.etapas) {
      expect(etapa.tasaDesdeAnterior).toBeNull();
    }
    expect(res.body.tasaGlobal).toBeNull();
    expect(res.body.fuentesTrafico).toEqual([]);
    expect(res.body.confiableDesde).toBeNull();
  });

  it("normaliza los referrers a host y agrupa el tráfico directo en su propio bucket", async () => {
    mockEventos({
      referrers: [
        { referrer: "https://instagram.com/yima", _count: { _all: 5 } },
        { referrer: "https://www.instagram.com/otro/post", _count: { _all: 3 } },
        { referrer: "https://google.com/search?q=yima", _count: { _all: 4 } },
        { referrer: null, _count: { _all: 20 } },
        { referrer: "", _count: { _all: 2 } },
        { referrer: "no-es-una-url", _count: { _all: 1 } },
      ],
    });

    const res = await request(buildApp())
      .get("/api/admin/embudo?desde=2026-08-01&hasta=2026-08-10")
      .set("Authorization", authHeader);

    const porFuente = Object.fromEntries(
      res.body.fuentesTrafico.map((fuente) => [fuente.fuente, fuente.cantidad]),
    );

    // `www.` se colapsa contra el mismo host: 5 + 3.
    expect(porFuente["instagram.com"]).toBe(8);
    expect(porFuente["google.com"]).toBe(4);
    // Null y string vacío caen los dos en el bucket de directo: 20 + 2.
    expect(porFuente["Directo"]).toBe(22);
    // Un referrer no parseable no rompe la respuesta ni desaparece.
    expect(porFuente["no-es-una-url"]).toBe(1);

    // Ordenado de mayor a menor.
    const cantidades = res.body.fuentesTrafico.map((fuente) => fuente.cantidad);
    expect([...cantidades].sort((a, b) => b - a)).toEqual(cantidades);
  });

  it("devuelve el período parseado y respeta el tope de días como /ventas", async () => {
    const res = await request(buildApp())
      .get("/api/admin/embudo?desde=2000-01-01&hasta=2026-08-19")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.periodo.recortado).toBe(true);
    expect(res.body.periodo.hasta).toBe("2026-08-19");
  });
});
