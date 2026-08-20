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
    eventoTrafico: { groupBy: vi.fn() },
    orden: {
      findMany: (...args) => ordenFindManyMock(...args),
      count: vi.fn(),
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
 * Construye una orden con su cliente, tal como la devuelve Prisma:
 * `precioUnitario` llega como `Decimal`, que es el caso que el controller
 * tiene que manejar sin perder precisión.
 */
function orden({ id, estado, createdAt, cliente, items = [] }) {
  return {
    id,
    estado,
    createdAt: new Date(createdAt),
    clienteId: cliente.id,
    cliente: {
      id: cliente.id,
      dni: cliente.dni,
      nombre: cliente.nombre,
    },
    items: items.map((item, indice) => ({
      id: id * 100 + indice,
      ordenId: id,
      precioUnitario: new Decimal(item.precioUnitario),
      cantidad: item.cantidad,
    })),
  };
}

const ANA = { id: 1, dni: "30111222", nombre: "Ana" };
const BETO = { id: 2, dni: "28333444", nombre: "Beto" };
const CARLA = { id: 3, dni: "35555666", nombre: "Carla" };

beforeEach(() => {
  ordenFindManyMock.mockReset();
});

describe("GET /api/admin/clientes-resumen", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/admin/clientes-resumen");
    expect(res.status).toBe(401);
  });

  it("separa clientes nuevos de recurrentes según sus órdenes de por vida", async () => {
    // Ana compró dos veces (recurrente), Beto una sola (nuevo).
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-01T12:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "ENTREGADA",
        createdAt: "2026-08-10T12:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "200.00", cantidad: 1 }],
      }),
      orden({
        id: 3,
        estado: "CONFIRMADA",
        createdAt: "2026-08-11T12:00:00Z",
        cliente: BETO,
        items: [{ precioUnitario: "50.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.totalClientes).toBe(2);
    expect(res.body.clientesRecurrentes).toBe(1);
    expect(res.body.clientesNuevos).toBe(1);
  });

  it("cuenta como recurrente a quien repitió fuera del período pedido", async () => {
    // La segunda orden de Ana cae fuera del rango consultado, pero un cliente
    // que repitió sigue siendo recurrente: la condición es de por vida.
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-01-05T12:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    // Solo una orden cae en el período, pero el cliente ya había comprado.
    expect(res.body.totalClientes).toBe(1);
    expect(res.body.clientesRecurrentes).toBe(1);
    expect(res.body.clientesNuevos).toBe(0);
  });

  it("descarta PENDIENTE y CANCELADA en la base, no en memoria", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    // El filtro va en el `where` de la query, no en un `if` posterior: una
    // orden PENDIENTE o CANCELADA nunca llega al cálculo. Filtrar en memoria
    // traería filas de más desde la base para después tirarlas.
    const args = ordenFindManyMock.mock.calls[0][0];
    expect(args.where.estado).toEqual({ in: ["CONFIRMADA", "EN_PREPARACION", "ENTREGADA"] });
    expect(args.where.estado.in).not.toContain("PENDIENTE");
    expect(args.where.estado.in).not.toContain("CANCELADA");

    expect(res.body.totalClientes).toBe(1);
    expect(res.body.ingresosPeriodo).toBe("100.00");
  });

  it("calcula el valor promedio por cliente desde los snapshots de los items", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        cliente: ANA,
        items: [
          { precioUnitario: "1000.00", cantidad: 2 },
          { precioUnitario: "500.50", cantidad: 1 },
        ],
      }),
      orden({
        id: 2,
        estado: "ENTREGADA",
        createdAt: "2026-08-11T12:00:00Z",
        cliente: BETO,
        items: [{ precioUnitario: "999.50", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    // 2500.50 + 999.50 = 3500.00 sobre 2 clientes = 1750.00
    expect(res.body.ingresosPeriodo).toBe("3500.00");
    expect(res.body.valorPromedioPorCliente).toBe("1750.00");
  });

  it("no pierde precisión acumulando montos con decimales", async () => {
    // 0.10 * 7, diez veces. En float esto da 7.000000000000001.
    ordenFindManyMock.mockResolvedValue(
      Array.from({ length: 10 }, (_unused, indice) =>
        orden({
          id: indice + 1,
          estado: "CONFIRMADA",
          createdAt: "2026-08-10T12:00:00Z",
          cliente: ANA,
          items: [{ precioUnitario: "0.10", cantidad: 7 }],
        }),
      ),
    );

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.body.ingresosPeriodo).toBe("7.00");
    expect(res.body.valorPromedioPorCliente).toBe("7.00");
  });

  it("rankea a los mejores clientes por facturación de por vida", async () => {
    ordenFindManyMock.mockResolvedValue([
      // Beto: una sola orden grande.
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        cliente: BETO,
        items: [{ precioUnitario: "5000.00", cantidad: 1 }],
      }),
      // Ana: dos órdenes que suman más que la de Beto.
      orden({
        id: 2,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "4000.00", cantidad: 1 }],
      }),
      orden({
        id: 3,
        estado: "ENTREGADA",
        createdAt: "2026-08-11T12:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "3000.00", cantidad: 1 }],
      }),
      // Carla: la más chica.
      orden({
        id: 4,
        estado: "CONFIRMADA",
        createdAt: "2026-08-12T12:00:00Z",
        cliente: CARLA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    const ranking = res.body.rankingClientes;
    expect(ranking).toHaveLength(3);
    expect(ranking[0]).toMatchObject({
      dni: ANA.dni,
      nombre: "Ana",
      cantidadOrdenes: 2,
      facturacion: "7000.00",
    });
    expect(ranking[1]).toMatchObject({
      dni: BETO.dni,
      cantidadOrdenes: 1,
      facturacion: "5000.00",
    });
    expect(ranking[2]).toMatchObject({ dni: CARLA.dni, facturacion: "100.00" });
  });

  it("corta el ranking en 10 clientes", async () => {
    ordenFindManyMock.mockResolvedValue(
      Array.from({ length: 15 }, (_unused, indice) =>
        orden({
          id: indice + 1,
          estado: "CONFIRMADA",
          createdAt: "2026-08-10T12:00:00Z",
          cliente: { id: indice + 1, dni: `dni-${indice}`, nombre: `Cliente ${indice}` },
          items: [{ precioUnitario: `${(indice + 1) * 100}.00`, cantidad: 1 }],
        }),
      ),
    );

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.body.rankingClientes).toHaveLength(10);
    // El más grande primero: el índice 14 factura 1500.
    expect(res.body.rankingClientes[0].facturacion).toBe("1500.00");
  });

  it("calcula la tasa de recompra como proporción de clientes que repitieron", async () => {
    // Ana repite, Beto y Carla no: 1 de 3 = 0.3333
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-01T12:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "CONFIRMADA",
        createdAt: "2026-08-05T12:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 3,
        estado: "CONFIRMADA",
        createdAt: "2026-08-06T12:00:00Z",
        cliente: BETO,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 4,
        estado: "CONFIRMADA",
        createdAt: "2026-08-07T12:00:00Z",
        cliente: CARLA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.body.tasaRecompra).toBe(0.3333);
  });

  it("devuelve tiempoEntreCompras null cuando ningún cliente repitió", async () => {
    // Estado real de los datos hoy: tres clientes, una orden cada uno. Un 0
    // acá sería una mentira ("compran de nuevo el mismo día"): debe ser null
    // para que la UI muestre "sin datos suficientes".
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-01T12:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "CONFIRMADA",
        createdAt: "2026-08-05T12:00:00Z",
        cliente: BETO,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 3,
        estado: "CONFIRMADA",
        createdAt: "2026-08-07T12:00:00Z",
        cliente: CARLA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.body.tiempoEntreCompras).toBeNull();
    expect(res.body.clientesRecurrentes).toBe(0);
    expect(res.body.tasaRecompra).toBe(0);
  });

  it("promedia los días entre compras consecutivas de quienes sí repitieron", async () => {
    ordenFindManyMock.mockResolvedValue([
      // Ana: 01 -> 11 -> 21, o sea dos intervalos de 10 días.
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-01T00:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "CONFIRMADA",
        createdAt: "2026-08-11T00:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 3,
        estado: "CONFIRMADA",
        createdAt: "2026-08-21T00:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      // Beto: 01 -> 05, un intervalo de 4 días.
      orden({
        id: 4,
        estado: "CONFIRMADA",
        createdAt: "2026-08-01T00:00:00Z",
        cliente: BETO,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 5,
        estado: "CONFIRMADA",
        createdAt: "2026-08-05T00:00:00Z",
        cliente: BETO,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      // Carla no repitió: no aporta ningún intervalo.
      orden({
        id: 6,
        estado: "CONFIRMADA",
        createdAt: "2026-08-03T00:00:00Z",
        cliente: CARLA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-25")
      .set("Authorization", authHeader);

    // Se promedian los intervalos, no los clientes: (10 + 10 + 4) / 3 = 8
    expect(res.body.tiempoEntreCompras).toBe(8);
  });

  it("ordena las compras por fecha antes de medir los intervalos", async () => {
    // Prisma no garantiza orden sin `orderBy` explícito: si el controller no
    // ordena, este caso da un intervalo negativo.
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 2,
        estado: "CONFIRMADA",
        createdAt: "2026-08-21T00:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-01T00:00:00Z",
        cliente: ANA,
        items: [{ precioUnitario: "100.00", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-25")
      .set("Authorization", authHeader);

    expect(res.body.tiempoEntreCompras).toBe(20);
  });

  it("devuelve ceros (no NaN ni null) cuando el período no tiene clientes", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.totalClientes).toBe(0);
    expect(res.body.clientesNuevos).toBe(0);
    expect(res.body.clientesRecurrentes).toBe(0);
    expect(res.body.ingresosPeriodo).toBe("0.00");
    // División por cero protegida: promedio y tasa en 0, nunca NaN.
    expect(res.body.valorPromedioPorCliente).toBe("0.00");
    expect(res.body.tasaRecompra).toBe(0);
    expect(Number.isNaN(res.body.tasaRecompra)).toBe(false);
    // El tiempo entre compras sigue siendo null: no hay dato, no es un cero.
    expect(res.body.tiempoEntreCompras).toBeNull();
    expect(res.body.rankingClientes).toEqual([]);
  });

  it("filtra por rango desde/hasta y devuelve el período aplicado", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.periodo).toMatchObject({
      desde: "2026-08-01",
      hasta: "2026-08-15",
      recortado: false,
    });
  });

  it("consulta el histórico completo, no solo el período, para clasificar recurrencia", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    // La recurrencia y la facturación de por vida no se pueden calcular con
    // una consulta acotada al período: la query no debe filtrar por fecha.
    const args = ordenFindManyMock.mock.calls[0][0];
    expect(args.where?.createdAt).toBeUndefined();
    // Y solo trae los estados que cuentan como venta, filtrado en la base.
    expect(args.where.estado).toEqual({ in: ["CONFIRMADA", "EN_PREPARACION", "ENTREGADA"] });
  });

  it("cae al período por defecto si las fechas son inválidas, sin tirar 500", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/admin/clientes-resumen?desde=no-es-fecha&hasta=tampoco")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.periodo.desde).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.periodo.hasta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
