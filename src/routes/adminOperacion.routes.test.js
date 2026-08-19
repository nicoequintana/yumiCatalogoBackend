import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET = "test-secret";

const ordenGroupByMock = vi.fn();
const ordenFindManyMock = vi.fn();
const ordenCountMock = vi.fn();
const productFindManyMock = vi.fn();
const eventoGroupByMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    orden: {
      groupBy: (...args) => ordenGroupByMock(...args),
      findMany: (...args) => ordenFindManyMock(...args),
      count: (...args) => ordenCountMock(...args),
    },
    product: {
      findMany: (...args) => productFindManyMock(...args),
    },
    eventoTrafico: {
      groupBy: (...args) => eventoGroupByMock(...args),
    },
    // Los otros feeds del router admin comparten el mismo mock de prisma.
    errorLog: { findMany: vi.fn(), count: vi.fn() },
    auditLog: { findMany: vi.fn(), count: vi.fn() },
  },
}));

const { default: adminRouter } = await import("./admin.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

const token = jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Fecha a N días en el pasado, para construir órdenes con antigüedad conocida.
 *
 * Se resta una hora extra para que el `Math.floor` del controlador no quede
 * justo sobre el borde del día: sin ese margen, los milisegundos que pasan
 * entre construir el mock y ejecutar el request hacen que N días caigan a N-1
 * de forma intermitente.
 */
function haceDias(dias) {
  return new Date(Date.now() - dias * MS_POR_DIA - 60 * 60 * 1000);
}

/** Respuestas por defecto: todo vacío. Cada test sobreescribe lo que le importa. */
function mockVacio() {
  ordenGroupByMock.mockResolvedValue([]);
  ordenFindManyMock.mockResolvedValue([]);
  ordenCountMock.mockResolvedValue(0);
  productFindManyMock.mockResolvedValue([]);
  eventoGroupByMock.mockResolvedValue([]);
}

function pedirOperacion(query = "") {
  return request(buildApp()).get(`/api/admin/operacion${query}`).set("Authorization", authHeader);
}

beforeEach(() => {
  ordenGroupByMock.mockReset();
  ordenFindManyMock.mockReset();
  ordenCountMock.mockReset();
  productFindManyMock.mockReset();
  eventoGroupByMock.mockReset();
  mockVacio();
});

describe("GET /api/admin/operacion", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/admin/operacion");
    expect(res.status).toBe(401);
  });

  it("devuelve el conteo de órdenes por estado, con cero en los estados sin órdenes", async () => {
    ordenGroupByMock.mockResolvedValue([
      { estado: "CONFIRMADA", _count: { _all: 2 } },
      { estado: "CANCELADA", _count: { _all: 1 } },
    ]);

    const res = await pedirOperacion();

    expect(res.status).toBe(200);
    // Los 5 estados siempre presentes: un estado sin órdenes vale 0, no falta
    // de la respuesta (la UI no tiene que adivinar si es cero o si no vino).
    expect(res.body.ordenesPorEstado).toEqual({
      PENDIENTE: 0,
      CONFIRMADA: 2,
      EN_PREPARACION: 0,
      ENTREGADA: 0,
      CANCELADA: 1,
    });
  });

  it("solo considera estancadas las órdenes en estados NO terminales", async () => {
    const res = await pedirOperacion();

    expect(res.status).toBe(200);
    // La query de estancadas nunca debe alcanzar ENTREGADA ni CANCELADA: una
    // orden terminal no está "frenada", está terminada.
    const argsEstancadas = ordenFindManyMock.mock.calls.map(([args]) => args);
    const conEstados = argsEstancadas.find((args) => args?.where?.estado?.in);
    expect(conEstados.where.estado.in).toEqual(["PENDIENTE", "CONFIRMADA", "EN_PREPARACION"]);
    expect(conEstados.where.estado.in).not.toContain("ENTREGADA");
    expect(conEstados.where.estado.in).not.toContain("CANCELADA");
  });

  it("respeta el umbral de días: filtra por updatedAt anterior al corte", async () => {
    const res = await pedirOperacion();

    expect(res.status).toBe(200);
    const argsEstancadas = ordenFindManyMock.mock.calls
      .map(([args]) => args)
      .find((args) => args?.where?.estado?.in);

    // El corte es `now - UMBRAL`: solo órdenes cuyo último cambio es anterior.
    const corte = argsEstancadas.where.updatedAt.lt;
    expect(corte).toBeInstanceOf(Date);
    const diasDeCorte = (Date.now() - corte.getTime()) / MS_POR_DIA;
    expect(diasDeCorte).toBeGreaterThan(2.9);
    expect(diasDeCorte).toBeLessThan(3.1);
  });

  it("devuelve la lista de estancadas ordenada de más estancada a menos", async () => {
    ordenFindManyMock.mockImplementation(async (args) => {
      if (!args?.where?.estado?.in) return [];
      return [
        {
          id: 7,
          estado: "PENDIENTE",
          updatedAt: haceDias(12),
          cliente: { nombre: "Ana Gómez" },
          items: [{ precioUnitario: "100.00", cantidad: 2 }],
        },
        {
          id: 4,
          estado: "CONFIRMADA",
          updatedAt: haceDias(5),
          cliente: { nombre: "Luis Paz" },
          items: [{ precioUnitario: "50.00", cantidad: 1 }],
        },
      ];
    });
    ordenCountMock.mockResolvedValue(2);

    const res = await pedirOperacion();

    expect(res.status).toBe(200);
    expect(res.body.ordenesEstancadas.total).toBe(2);
    expect(res.body.ordenesEstancadas.lista).toHaveLength(2);

    const [primera, segunda] = res.body.ordenesEstancadas.lista;
    expect(primera.id).toBe(7);
    expect(primera.estado).toBe("PENDIENTE");
    expect(primera.diasSinCambios).toBe(12);
    expect(primera.clienteNombre).toBe("Ana Gómez");
    expect(primera.total).toBe("200.00");

    expect(segunda.id).toBe(4);
    expect(segunda.diasSinCambios).toBe(5);
    expect(segunda.total).toBe("50.00");

    // Más estancada primero: es la que más urge destrabar.
    expect(primera.diasSinCambios).toBeGreaterThan(segunda.diasSinCambios);
  });

  it("calcula la antigüedad promedio sin cambios por estado no terminal", async () => {
    ordenFindManyMock.mockImplementation(async (args) => {
      // La query de antigüedad trae TODAS las no terminales, sin filtro de updatedAt.
      if (args?.where?.estado?.in && !args.where.updatedAt) {
        return [
          { id: 1, estado: "PENDIENTE", updatedAt: haceDias(2) },
          { id: 2, estado: "PENDIENTE", updatedAt: haceDias(4) },
          { id: 3, estado: "CONFIRMADA", updatedAt: haceDias(10) },
        ];
      }
      return [];
    });

    const res = await pedirOperacion();

    expect(res.status).toBe(200);
    expect(res.body.antiguedadPromedio).toEqual({
      PENDIENTE: 3,
      CONFIRMADA: 10,
      EN_PREPARACION: 0,
    });
  });

  it("quiebres de stock: solo incluye productos sin stock QUE TUVIERON vistas", async () => {
    productFindManyMock.mockImplementation(async (args) => {
      if (args?.where?.stock?.lte === 0) {
        return [
          { id: 1, nombre: "Vela sin demanda", stock: 0 },
          { id: 2, nombre: "Perfume agotado", stock: 0 },
          { id: 3, nombre: "Jabón agotado", stock: -1 },
        ];
      }
      return [];
    });
    eventoGroupByMock.mockResolvedValue([
      { productId: 2, _count: { _all: 40 } },
      { productId: 3, _count: { _all: 9 } },
      // Producto 1 no aparece: cero vistas en el período.
    ]);

    const res = await pedirOperacion();

    expect(res.status).toBe(200);
    const ids = res.body.quiebresConDemanda.map((fila) => fila.productId);
    // Stock cero SIN vistas no es accionable: no hay demanda que perder.
    expect(ids).not.toContain(1);
    // Y ordenados por vistas desc: el que más demanda perdió, primero.
    expect(ids).toEqual([2, 3]);
    expect(res.body.quiebresConDemanda[0]).toEqual({
      productId: 2,
      nombre: "Perfume agotado",
      vistas: 40,
      stock: 0,
    });
    expect(res.body.quiebresConDemanda[1].stock).toBe(-1);
  });

  it("solo cuenta eventos VISTA_PRODUCTO del período para la demanda perdida", async () => {
    await pedirOperacion();

    expect(eventoGroupByMock).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ["productId"],
        where: expect.objectContaining({ tipo: "VISTA_PRODUCTO" }),
      }),
    );
  });

  it("stock bajo usa el mismo umbral que el badge 'Últimos N': stock > 0 && stock <= 3", async () => {
    productFindManyMock.mockImplementation(async (args) => {
      if (args?.where?.stock?.gt === 0) {
        return [
          { id: 5, nombre: "Crema", stock: 1 },
          { id: 6, nombre: "Aceite", stock: 3 },
        ];
      }
      return [];
    });

    const res = await pedirOperacion();

    expect(res.status).toBe(200);
    const argsStockBajo = productFindManyMock.mock.calls
      .map(([args]) => args)
      .find((args) => args?.where?.stock?.gt === 0);

    expect(argsStockBajo.where.stock).toEqual({ gt: 0, lte: 3 });
    expect(res.body.stockBajo).toEqual([
      { productId: 5, nombre: "Crema", stock: 1 },
      { productId: 6, nombre: "Aceite", stock: 3 },
    ]);
  });

  it("un período sin datos devuelve ceros y arrays vacíos, nunca NaN ni null", async () => {
    const res = await pedirOperacion("?desde=2020-01-01&hasta=2020-01-31");

    expect(res.status).toBe(200);
    expect(res.body.ordenesPorEstado).toEqual({
      PENDIENTE: 0,
      CONFIRMADA: 0,
      EN_PREPARACION: 0,
      ENTREGADA: 0,
      CANCELADA: 0,
    });
    expect(res.body.ordenesEstancadas).toEqual({ total: 0, lista: [] });
    expect(res.body.antiguedadPromedio).toEqual({
      PENDIENTE: 0,
      CONFIRMADA: 0,
      EN_PREPARACION: 0,
    });
    expect(res.body.quiebresConDemanda).toEqual([]);
    expect(res.body.stockBajo).toEqual([]);

    // Ningún valor numérico puede salir NaN: el frontend los formatea directo.
    for (const valor of Object.values(res.body.antiguedadPromedio)) {
      expect(Number.isNaN(valor)).toBe(false);
    }
  });

  it("devuelve el período parseado y expone el umbral de estancamiento usado", async () => {
    const res = await pedirOperacion("?desde=2026-08-01&hasta=2026-08-15");

    expect(res.status).toBe(200);
    expect(res.body.periodo).toEqual({
      desde: "2026-08-01",
      hasta: "2026-08-15",
      recortado: false,
    });
    // La UI necesita el umbral para rotular la tabla sin hardcodearlo.
    expect(res.body.umbralEstancamientoDias).toBe(3);
  });
});
