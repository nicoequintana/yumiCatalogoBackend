import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { Decimal } from "@prisma/client/runtime/client.js";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const ordenFindManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    errorLog: { findMany: vi.fn(), count: vi.fn() },
    auditLog: { findMany: vi.fn(), count: vi.fn() },
    orden: {
      findMany: (...args) => ordenFindManyMock(...args),
    },
  },
}));

const { default: adminRouter } = await import("./admin.routes.js");
const { MAX_ORDENES_HISTORICO } = await import("../controllers/admin.controller.js");

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
 * Construye una orden como la devuelve Prisma: `precioUnitario` llega como
 * `Decimal`, no como number, que es exactamente el caso que el controller
 * tiene que manejar sin perder precisión.
 */
function orden({ id, estado, createdAt, items = [] }) {
  return {
    id,
    estado,
    createdAt: new Date(createdAt),
    items: items.map((item, indice) => ({
      id: id * 100 + indice,
      ordenId: id,
      productId: item.productId,
      nombreProducto: item.nombreProducto,
      precioUnitario: new Decimal(item.precioUnitario),
      cantidad: item.cantidad,
    })),
  };
}

// Debe coincidir con `MAX_DIAS_PERIODO` de `admin.controller.js`.
const MAX_DIAS_PERIODO = 400;

beforeEach(() => {
  ordenFindManyMock.mockReset();
});

describe("GET /api/admin/ventas", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/admin/ventas");
    expect(res.status).toBe(401);
  });

  it("calcula ingresos, órdenes, ticket promedio y unidades desde los snapshots", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [
          { productId: 1, nombreProducto: "Vela", precioUnitario: "1000.00", cantidad: 2 },
          { productId: 2, nombreProducto: "Difusor", precioUnitario: "500.50", cantidad: 1 },
        ],
      }),
      orden({
        id: 2,
        estado: "ENTREGADA",
        createdAt: "2026-08-11T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "1000.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    // 1000*2 + 500.50 + 1000 = 3500.50
    expect(res.body.ingresosTotales).toBe("3500.50");
    expect(res.body.cantidadOrdenes).toBe(2);
    // 3500.50 / 2 = 1750.25
    expect(res.body.ticketPromedio).toBe("1750.25");
    expect(res.body.unidadesVendidas).toBe(4);
    // 3 items / 2 órdenes = 1.5
    expect(res.body.productosPorOrden).toBe(1.5);
  });

  it("cuenta CONFIRMADA, EN_PREPARACION y ENTREGADA como ingreso", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 3,
        estado: "ENTREGADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.body.ingresosTotales).toBe("300.00");
    expect(res.body.cantidadOrdenes).toBe(3);
  });

  it("excluye PENDIENTE del ingreso y lo reporta aparte como pipeline", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "PENDIENTE",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 2, nombreProducto: "Difusor", precioUnitario: "999.99", cantidad: 2 }],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.body.ingresosTotales).toBe("100.00");
    expect(res.body.cantidadOrdenes).toBe(1);
    expect(res.body.pipeline.cantidadOrdenes).toBe(1);
    expect(res.body.pipeline.valorTotal).toBe("1999.98");
    // El pipeline no debe aparecer en el ranking ni en la serie de ingresos.
    expect(res.body.rankingProductos.some((p) => p.nombre === "Difusor")).toBe(false);
  });

  it("excluye CANCELADA del ingreso y la refleja en la tasa de cancelación", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "CANCELADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 5 }],
      }),
      orden({
        id: 3,
        estado: "CANCELADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 5 }],
      }),
      orden({
        id: 4,
        estado: "PENDIENTE",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.body.ingresosTotales).toBe("100.00");
    expect(res.body.ordenesCanceladas).toBe(2);
    // 2 canceladas sobre 4 órdenes totales del período = 0.5
    expect(res.body.tasaCancelacion).toBe(0.5);
  });

  it("rankea productos por facturación, no por unidades", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [
          // Barato pero muchas unidades: 10 * 10 = 100
          { productId: 1, nombreProducto: "Jabón", precioUnitario: "10.00", cantidad: 10 },
          // Caro con pocas unidades: 2 * 500 = 1000 -> debe ir primero
          { productId: 2, nombreProducto: "Perfume", precioUnitario: "500.00", cantidad: 2 },
        ],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.body.rankingProductos[0]).toMatchObject({
      productId: 2,
      nombre: "Perfume",
      unidades: 2,
      facturacion: "1000.00",
    });
    expect(res.body.rankingProductos[1]).toMatchObject({
      productId: 1,
      nombre: "Jabón",
      unidades: 10,
      facturacion: "100.00",
    });
  });

  it("agrupa los ingresos por día en la serie temporal", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T09:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T20:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "50.00", cantidad: 1 }],
      }),
      orden({
        id: 3,
        estado: "ENTREGADA",
        createdAt: "2026-08-12T10:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "25.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=2026-08-10&hasta=2026-08-12")
      .set("Authorization", authHeader);

    const serie = res.body.serieTemporal;
    // Los dos del 10 se suman en un único punto.
    const dia10 = serie.find((punto) => punto.fecha === "2026-08-10");
    expect(dia10.ingresos).toBe("150.00");
    const dia12 = serie.find((punto) => punto.fecha === "2026-08-12");
    expect(dia12.ingresos).toBe("25.00");
    // Un día sin ventas dentro del rango sigue presente, en cero, para que
    // el gráfico no comprima el eje temporal.
    const dia11 = serie.find((punto) => punto.fecha === "2026-08-11");
    expect(dia11.ingresos).toBe("0.00");
  });

  it("devuelve ceros (no null ni NaN) cuando el período no tiene órdenes", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.ingresosTotales).toBe("0.00");
    expect(res.body.cantidadOrdenes).toBe(0);
    // División por cero: ticket promedio y productos por orden deben ser 0.
    expect(res.body.ticketPromedio).toBe("0.00");
    expect(res.body.productosPorOrden).toBe(0);
    expect(res.body.unidadesVendidas).toBe(0);
    expect(res.body.tasaCancelacion).toBe(0);
    expect(res.body.pipeline).toMatchObject({ cantidadOrdenes: 0, valorTotal: "0.00" });
    expect(res.body.rankingProductos).toEqual([]);
    expect(Number.isNaN(res.body.tasaCancelacion)).toBe(false);
  });

  it("no pierde precisión acumulando montos con decimales", async () => {
    // 0.10 * 7, diez veces. En aritmética float esto da 7.000000000000001.
    ordenFindManyMock.mockResolvedValue(
      Array.from({ length: 10 }, (_unused, indice) =>
        orden({
          id: indice + 1,
          estado: "CONFIRMADA",
          createdAt: "2026-08-10T12:00:00Z",
          items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "0.10", cantidad: 7 }],
        }),
      ),
    );

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.body.ingresosTotales).toBe("7.00");
  });

  it("filtra por rango desde/hasta pasándoselo a la query", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    const args = ordenFindManyMock.mock.calls[0][0];
    expect(args.where.createdAt.gte).toEqual(new Date("2026-08-01T00:00:00.000Z"));
    // `hasta` es inclusivo: se consulta hasta el final de ese día.
    expect(args.where.createdAt.lte).toEqual(new Date("2026-08-15T23:59:59.999Z"));
    expect(res.body.periodo).toMatchObject({ desde: "2026-08-01", hasta: "2026-08-15" });
  });

  it("cae al período por defecto si las fechas son inválidas, sin tirar 500", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=no-es-fecha&hasta=tampoco")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.periodo.desde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.periodo.hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("corrige el rango si desde es posterior a hasta, en vez de devolver vacío", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=2026-08-20&hasta=2026-08-01")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.periodo.desde).toBe("2026-08-01");
    expect(res.body.periodo.hasta).toBe("2026-08-20");
  });

  it("recorta un rango excesivo al tope de días, sin devolver una serie gigante", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    // La serie temporal rellena con 0.00 los días sin ventas, así que un rango
    // de 10 años devolvía ~3650 puntos (y ~150KB) casi todos vacíos. Se recorta
    // conservando `hasta`: interesa el período reciente, no el arranque.
    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=2020-01-01&hasta=2030-01-01")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.serieTemporal.length).toBeLessThanOrEqual(MAX_DIAS_PERIODO);
    expect(res.body.periodo.hasta).toBe("2030-01-01");
    expect(res.body.periodo.recortado).toBe(true);
  });

  it("no marca como recortado un rango que entra en el tope", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.periodo.recortado).toBe(false);
    expect(res.body.serieTemporal).toHaveLength(15);
  });
});

describe("GET /api/admin/ventas — tope de filas del histórico", () => {
  // Mismo patrón que `clientes-resumen`: sin techo, un período de hasta 400
  // días con muchas órdenes se carga y reduce entero en memoria. Se pide UNA
  // fila de más que el tope para detectar el corte sin adivinar, conservando
  // las más recientes, y la respuesta lo declara en `historico` — un flag
  // DISTINTO de `periodo.recortado` (ese habla del rango de fechas).
  it("consulta con take = tope + 1 y orderBy createdAt desc (conserva lo más reciente)", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    const args = ordenFindManyMock.mock.calls[0][0];
    expect(args.take).toBe(MAX_ORDENES_HISTORICO + 1);
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("declara historico.recortado: false cuando las órdenes entran en el tope", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.body.historico).toEqual({
      ordenesAnalizadas: 1,
      tope: MAX_ORDENES_HISTORICO,
      recortado: false,
    });
  });

  it("descarta la fila extra y declara historico.recortado: true al superar el tope", async () => {
    const unaOrden = orden({
      id: 1,
      estado: "CONFIRMADA",
      createdAt: "2026-08-10T12:00:00Z",
      items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100.00", cantidad: 1 }],
    });
    ordenFindManyMock.mockResolvedValue(Array.from({ length: MAX_ORDENES_HISTORICO + 1 }, () => unaOrden));

    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.historico.recortado).toBe(true);
    expect(res.body.historico.ordenesAnalizadas).toBe(MAX_ORDENES_HISTORICO);
    // La fila de más no puede contaminar los números: se analiza el tope justo.
    expect(res.body.cantidadOrdenes).toBe(MAX_ORDENES_HISTORICO);
  });
});
