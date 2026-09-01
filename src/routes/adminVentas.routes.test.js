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
const { MAX_ORDENES_HISTORICO, ESTADOS_FACTURABLES } = await import("../controllers/admin.controller.js");

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
 *
 * `costoUnitario` es NULLABLE en el modelo, así que un ítem que no lo declara
 * viaja como `null` — igual que toda línea anterior a que existiera la columna
 * y toda línea de un producto sin costo cargado. Es el caso que separa "no se
 * puede calcular el margen de esta línea" de "esta línea costó cero", y por eso
 * el helper NO lo completa con un default.
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
      costoUnitario:
        item.costoUnitario === undefined || item.costoUnitario === null
          ? null
          : new Decimal(item.costoUnitario),
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
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [
          { productId: 1, nombreProducto: "Vela", precioUnitario: "1000", cantidad: 2 },
          { productId: 2, nombreProducto: "Difusor", precioUnitario: "500", cantidad: 1 },
        ],
      }),
      orden({
        id: 2,
        estado: "ENTREGADA",
        createdAt: "2026-08-11T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "1000", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    // 1000*2 + 500 + 1000 = 3500
    expect(res.body.ingresosTotales).toBe("3500");
    expect(res.body.cantidadOrdenes).toBe(2);
    // 3500 / 2 = 1750
    expect(res.body.ticketPromedio).toBe("1750");
    expect(res.body.unidadesVendidas).toBe(4);
    // 3 items / 2 órdenes = 1.5
    expect(res.body.productosPorOrden).toBe(1.5);
  });

  it("cuenta EN_PREPARACION y ENTREGADA como ingreso; CONFIRMADA ya no cuenta", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "CONFIRMADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 1 }],
      }),
      orden({
        id: 3,
        estado: "ENTREGADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    // Solo las dos últimas cuentan: CONFIRMADA quedó fuera de ESTADOS_FACTURABLES.
    expect(res.body.ingresosTotales).toBe("200");
    expect(res.body.cantidadOrdenes).toBe(2);
  });

  it("excluye PENDIENTE del ingreso y lo reporta aparte en porEstado", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "PENDIENTE",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 2, nombreProducto: "Difusor", precioUnitario: "999", cantidad: 2 }],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.body.ingresosTotales).toBe("100");
    expect(res.body.cantidadOrdenes).toBe(1);
    // El mismo dato que antes reportaba `pipeline`, ahora como una entrada más
    // del desglose por estado: ingreso potencial que NO se suma al facturado.
    const pendiente = res.body.porEstado.find((e) => e.estado === "PENDIENTE");
    expect(pendiente.cantidadOrdenes).toBe(1);
    expect(pendiente.venta).toBe("1998");
    // Lo pendiente no debe aparecer en el ranking ni en la serie de ingresos.
    expect(res.body.rankingProductos.some((p) => p.nombre === "Difusor")).toBe(false);
  });

  it("excluye CANCELADA del ingreso y la refleja en la tasa de cancelación", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "CANCELADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 5 }],
      }),
      orden({
        id: 3,
        estado: "CANCELADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 5 }],
      }),
      orden({
        id: 4,
        estado: "PENDIENTE",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.body.ingresosTotales).toBe("100");
    expect(res.body.ordenesCanceladas).toBe(2);
    // 2 canceladas sobre 4 órdenes totales del período = 0.5
    expect(res.body.tasaCancelacion).toBe(0.5);
  });

  it("rankea productos por facturación, no por unidades", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [
          // Barato pero muchas unidades: 10 * 10 = 100
          { productId: 1, nombreProducto: "Jabón", precioUnitario: "10", cantidad: 10 },
          // Caro con pocas unidades: 2 * 500 = 1000 -> debe ir primero
          { productId: 2, nombreProducto: "Perfume", precioUnitario: "500", cantidad: 2 },
        ],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.body.rankingProductos[0]).toMatchObject({
      productId: 2,
      nombre: "Perfume",
      unidades: 2,
      facturacion: "1000",
    });
    expect(res.body.rankingProductos[1]).toMatchObject({
      productId: 1,
      nombre: "Jabón",
      unidades: 10,
      facturacion: "100",
    });
  });

  it("agrupa los ingresos por día en la serie temporal", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T09:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T20:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "50", cantidad: 1 }],
      }),
      orden({
        id: 3,
        estado: "ENTREGADA",
        createdAt: "2026-08-12T10:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "25", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=2026-08-10&hasta=2026-08-12")
      .set("Authorization", authHeader);

    const serie = res.body.serieTemporal;
    // Los dos del 10 se suman en un único punto.
    const dia10 = serie.find((punto) => punto.fecha === "2026-08-10");
    expect(dia10.ingresos).toBe("150");
    const dia12 = serie.find((punto) => punto.fecha === "2026-08-12");
    expect(dia12.ingresos).toBe("25");
    // Un día sin ventas dentro del rango sigue presente, en cero, para que
    // el gráfico no comprima el eje temporal.
    const dia11 = serie.find((punto) => punto.fecha === "2026-08-11");
    expect(dia11.ingresos).toBe("0");
  });

  // Regresión del corrimiento de día. `aClaveDia` agrupaba por día UTC
  // (`toISOString().slice(0, 10)`) mientras el negocio vive en Buenos Aires
  // (UTC-3): toda venta de las 21:00 en adelante caía en el punto del día
  // SIGUIENTE del gráfico. El rótulo del eje quedaba bien y el número atrás
  // estaba corrido — nada lo delataba.
  it("agrupa por día ARGENTINO: una venta de las 22:30 ART queda en su propio día", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "EN_PREPARACION",
        // 22:30 del 15 en Buenos Aires ya es el 16 en UTC.
        createdAt: "2026-08-16T01:30:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "900", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=2026-08-14&hasta=2026-08-16")
      .set("Authorization", authHeader);

    const serie = res.body.serieTemporal;
    expect(serie.find((punto) => punto.fecha === "2026-08-15").ingresos).toBe("900");
    expect(serie.find((punto) => punto.fecha === "2026-08-16").ingresos).toBe("0");
  });

  it("devuelve ceros (no null ni NaN) cuando el período no tiene órdenes", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.ingresosTotales).toBe("0");
    expect(res.body.cantidadOrdenes).toBe(0);
    // División por cero: ticket promedio y productos por orden deben ser 0.
    expect(res.body.ticketPromedio).toBe("0");
    expect(res.body.productosPorOrden).toBe(0);
    expect(res.body.unidadesVendidas).toBe(0);
    expect(res.body.tasaCancelacion).toBe(0);
    // Los cuatro estados viajan igual, en cero: un cero es la respuesta ("no
    // tenés órdenes pendientes"), no la ausencia de respuesta.
    expect(res.body.porEstado).toEqual([
      { estado: "PENDIENTE", cantidadOrdenes: 0, venta: "0", costo: "0", ventaConCosto: "0" },
      { estado: "EN_PREPARACION", cantidadOrdenes: 0, venta: "0", costo: "0", ventaConCosto: "0" },
      { estado: "ENTREGADA", cantidadOrdenes: 0, venta: "0", costo: "0", ventaConCosto: "0" },
      { estado: "CANCELADA", cantidadOrdenes: 0, venta: "0", costo: "0", ventaConCosto: "0" },
    ]);
    expect(res.body.rankingProductos).toEqual([]);
    expect(Number.isNaN(res.body.tasaCancelacion)).toBe(false);
  });

  // El ticket promedio es la única métrica de este feed que DIVIDE, así que es
  // la única donde reaparece una parte fraccionaria aunque todos los montos de
  // entrada sean enteros. Se serializa redondeada, igual que el resto: la
  // respuesta no publica centavos por ningún camino.
  //
  // (El guard de "Decimal y no float" en la aritmética de montos vive ahora en
  // `lib/dinero.test.js`, que afirma sobre el `Decimal` sin redondear. Acá ya
  // no se puede: con montos enteros, float y Decimal dan el mismo resultado.)
  it("redondea el ticket promedio cuando la división no es exacta", async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "1000", cantidad: 1 }],
      }),
      orden({
        id: 2,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "1001", cantidad: 1 }],
      }),
      orden({
        id: 3,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "1000", cantidad: 1 }],
      }),
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    // 3001 / 3 = 1000.333... -> "1000", nunca "1000.33" ni la cola de flotante.
    expect(res.body.ingresosTotales).toBe("3001");
    expect(res.body.ticketPromedio).toBe("1000");
  });

  it("filtra por rango desde/hasta pasándoselo a la query", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/admin/ventas?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    const args = ordenFindManyMock.mock.calls[0][0];
    // Los límites son las medianoches ARGENTINAS expresadas en UTC: el 1 de
    // agosto a las 00:00 de Buenos Aires es `T03:00:00.000Z`. Se compara contra
    // `createdAt`, que la base guarda en UTC, así que el instante tiene que
    // seguir siendo UTC — lo que cambia es a qué momento corresponde. Anclado en
    // `T00:00:00Z`, el período arrancaba y terminaba a las 21:00 hora local.
    expect(args.where.createdAt.gte).toEqual(new Date("2026-08-01T03:00:00.000Z"));
    // `hasta` es inclusivo: se consulta hasta el final de ese día argentino,
    // o sea hasta las 02:59:59.999 UTC del 16.
    expect(args.where.createdAt.lte).toEqual(new Date("2026-08-16T02:59:59.999Z"));
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
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 1 }],
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
      estado: "EN_PREPARACION",
      createdAt: "2026-08-10T12:00:00Z",
      items: [{ productId: 1, nombreProducto: "Vela", precioUnitario: "100", cantidad: 1 }],
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

describe("GET /api/admin/ventas — porEstado", () => {
  /**
   * Fixture con los cuatro estados representados y, en la ENTREGADA, una línea
   * CON costo y otra SIN costo — el caso que separa las tres claves de plata:
   *
   *   ENTREGADA       24000 x 2 = 48000   (costo 13250 x 2 = 26500)
   *                    4000 x 1 =  4000   (sin costo)
   *                              = 52000 de venta, 48000 de venta con costo
   *   EN_PREPARACION   1000 x 3 =  3000   (costo   400 x 3 =  1200)
   *   PENDIENTE         999 x 2 =  1998   (sin costo)
   *   CANCELADA         500 x 1 =   500   (costo   200 x 1 =   200)
   */
  let respuesta;

  beforeEach(async () => {
    ordenFindManyMock.mockResolvedValue([
      orden({
        id: 1,
        estado: "ENTREGADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [
          {
            productId: 1,
            nombreProducto: "Vela",
            precioUnitario: "24000",
            costoUnitario: "13250",
            cantidad: 2,
          },
          // Sin `costoUnitario`: la línea existe y factura, pero no aporta costo.
          { productId: 2, nombreProducto: "Difusor", precioUnitario: "4000", cantidad: 1 },
        ],
      }),
      orden({
        id: 2,
        estado: "EN_PREPARACION",
        createdAt: "2026-08-10T12:00:00Z",
        items: [
          {
            productId: 3,
            nombreProducto: "Jabón",
            precioUnitario: "1000",
            costoUnitario: "400",
            cantidad: 3,
          },
        ],
      }),
      orden({
        id: 3,
        estado: "PENDIENTE",
        createdAt: "2026-08-10T12:00:00Z",
        items: [{ productId: 3, nombreProducto: "Jabón", precioUnitario: "999", cantidad: 2 }],
      }),
      orden({
        id: 4,
        estado: "CANCELADA",
        createdAt: "2026-08-10T12:00:00Z",
        items: [
          {
            productId: 1,
            nombreProducto: "Vela",
            precioUnitario: "500",
            costoUnitario: "200",
            cantidad: 1,
          },
        ],
      }),
    ]);

    respuesta = await request(buildApp())
      .get("/api/admin/ventas?desde=2026-08-01&hasta=2026-08-15")
      .set("Authorization", authHeader);
  });

  it("trae los cuatro estados en orden de flujo, también los que están en cero", () => {
    // Un cero es la respuesta ("no tenés órdenes pendientes"), no la ausencia
    // de respuesta: omitir la entrada obligaría a la pantalla a distinguir
    // "cero" de "no vino".
    const estados = respuesta.body.porEstado.map((e) => e.estado);
    expect(estados).toEqual(["PENDIENTE", "EN_PREPARACION", "ENTREGADA", "CANCELADA"]);
  });

  it("una línea sin costoUnitario queda fuera de costo Y de ventaConCosto", () => {
    // Si quedara fuera del costo pero su facturación siguiera contando como
    // facturación con costo, la ganancia derivada (ventaConCosto - costo)
    // saldría inflada: el mismo error que sumar los null como cero, con más
    // pasos.
    const entregada = respuesta.body.porEstado.find((e) => e.estado === "ENTREGADA");

    expect(entregada.cantidadOrdenes).toBe(1);
    expect(entregada.venta).toBe("52000");
    expect(entregada.ventaConCosto).toBe("48000");
    expect(entregada.costo).toBe("26500");
  });

  it("la suma de los estados facturables coincide con ingresosTotales", () => {
    // La misma plata desde dos agrupamientos distintos. Si no cierra, la
    // pantalla se contradice sola.
    const facturable = respuesta.body.porEstado
      .filter((e) => ESTADOS_FACTURABLES.includes(e.estado))
      .reduce((suma, e) => suma + Number(e.venta), 0);

    expect(String(facturable)).toBe(respuesta.body.ingresosTotales);
  });

  it("acumula PENDIENTE, que no entra en ningún total facturado", () => {
    const pendiente = respuesta.body.porEstado.find((e) => e.estado === "PENDIENTE");

    expect(pendiente.cantidadOrdenes).toBe(1);
    expect(pendiente.venta).toBe("1998");
    // Sin costo en esa línea: las dos claves de margen quedan en cero.
    expect(pendiente.costo).toBe("0");
    expect(pendiente.ventaConCosto).toBe("0");
  });

  it("CANCELADA viaja con sus montos aunque la pantalla no los muestre", () => {
    // El endpoint informa; qué se muestra lo decide la pantalla. Vaciar acá los
    // montos de lo cancelado le sacaría a la pantalla la posibilidad de decidir.
    const cancelada = respuesta.body.porEstado.find((e) => e.estado === "CANCELADA");

    expect(cancelada.cantidadOrdenes).toBe(1);
    expect(cancelada.venta).toBe("500");
    expect(cancelada.costo).toBe("200");
    expect(cancelada.ventaConCosto).toBe("500");
  });

  it("ya no emite la clave `pipeline`: la reemplaza la entrada PENDIENTE", () => {
    expect(respuesta.body.pipeline).toBeUndefined();
  });

  it("pide costoUnitario en el select de items, o el costo llegaría siempre nulo", () => {
    // Sin esa columna en el `select`, `costoDeItem` recibe `undefined` en cada
    // línea y todo el desglose de costo sale en cero — sin error y sin nada que
    // lo delate.
    const args = ordenFindManyMock.mock.calls[0][0];
    expect(args.select.items.select.costoUnitario).toBe(true);
  });
});

describe("ESTADOS_FACTURABLES", () => {
  it("cuenta como venta desde EN_PREPARACION, sin CONFIRMADA", () => {
    expect(ESTADOS_FACTURABLES).toEqual(["EN_PREPARACION", "ENTREGADA"]);
  });
});
