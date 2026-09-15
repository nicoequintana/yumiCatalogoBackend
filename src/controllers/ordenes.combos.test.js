import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

// El limitador de `POST /api/ordenes` es 10/10min con store en memoria por
// proceso: esta suite hace más de 10 POST. Mismo mock que ordenes.routes.test.js.
vi.mock("../middlewares/rateLimit.middleware.js", () => ({
  crearLimitadorDeVelocidad: () => (_req, _res, next) => next(),
}));
vi.mock("../middlewares/authCliente.middleware.js", () => ({
  authClienteOpcional: (req, _res, next) => {
    req.cuentaCliente = null;
    next();
  },
}));
vi.mock("../lib/env.js", () => ({ checkoutRequiereCuenta: () => false }));
vi.mock("../services/notificacionesOrden.service.js", () => ({
  notificarOrdenCreada: vi.fn().mockResolvedValue(undefined),
  notificarCambioEstado: vi.fn(),
}));

const productFindManyMock = vi.fn();
const comboFindManyMock = vi.fn();
const clienteFindUniqueMock = vi.fn();
const clienteCreateMock = vi.fn();
const ordenCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: { findMany: (...a) => productFindManyMock(...a) },
    combo: { findMany: (...a) => comboFindManyMock(...a) },
    promocionItem: { findMany: async () => [] },
    eventoTrafico: { create: vi.fn().mockResolvedValue({}) },
    claveIdempotencia: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: async (cb) =>
      cb({
        cliente: {
          findUnique: (...a) => clienteFindUniqueMock(...a),
          create: (...a) => clienteCreateMock(...a),
          update: vi.fn(),
        },
        orden: { create: (...a) => ordenCreateMock(...a) },
        claveIdempotencia: { create: vi.fn() },
      }),
  },
}));

const { default: ordenesRouter } = await import("../routes/ordenes.routes.js");
const { MAX_ITEMS_POR_ORDEN } = await import("./ordenes.controller.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ordenes", ordenesRouter);
  app.use(manejadorDeErrores);
  return app;
}

function pedir(items) {
  return request(buildApp())
    .post("/api/ordenes")
    .send({ dni: "30111222", nombre: "Ana", telefono: "1122334455", email: "ana@test.com", items });
}

const LAMPARA = { id: 1, nombre: "Lámpara", precio: 10000, costo: 4000, visibleEnCatalogo: true, stock: 9 };
const MESA = { id: 2, nombre: "Mesa", precio: 25000, costo: 12000, visibleEnCatalogo: true, stock: 4 };

function comboFixture({ lampara = {}, mesa = {}, ...extra } = {}) {
  return {
    id: 3,
    nombre: "Kit Living Cálido",
    porcentaje: 15,
    activo: true,
    vigencia: "SIEMPRE",
    campanias: [],
    items: [
      { productId: 1, cantidad: 2, product: { ...LAMPARA, ...lampara } },
      { productId: 2, cantidad: 1, product: { ...MESA, ...mesa } },
    ],
    ...extra,
  };
}

/** Las filas que `crear` le pasó a `orden.create`. */
function filasCreadas() {
  return ordenCreateMock.mock.calls[0][0].data.items.create;
}

beforeEach(() => {
  vi.clearAllMocks();
  productFindManyMock.mockResolvedValue([]);
  comboFindManyMock.mockResolvedValue([]);
  clienteFindUniqueMock.mockResolvedValue(null);
  clienteCreateMock.mockResolvedValue({ id: 9, dni: "30111222", nombre: "Ana" });
  ordenCreateMock.mockImplementation(({ data }) =>
    Promise.resolve({ id: 100, estado: "PENDIENTE", cliente: {}, cuentaCliente: null, items: data.items.create }),
  );
});

describe("POST /ordenes — forma de los items", () => {
  it("400 si una línea trae productId Y comboId a la vez", async () => {
    const res = await pedir([{ productId: 1, comboId: 3, cantidad: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cada item debe tener `productId` o `comboId`, nunca los dos ni ninguno.");
  });

  it("400 si una línea no trae ninguno de los dos", async () => {
    const res = await pedir([{ cantidad: 1 }]);
    expect(res.status).toBe(400);
  });

  it("400 con un comboId no entero", async () => {
    const res = await pedir([{ comboId: "tres", cantidad: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cada item debe tener un comboId válido.");
  });

  // `Number.isInteger(1e21)` es `true`: sin la guarda de rango el id llegaba a
  // Prisma y la orden cortaba con un 500 (ver `lib/enteroSeguro.js`).
  it("400 con un comboId fuera de rango seguro (1e21), sin consultar combos", async () => {
    const res = await pedir([{ comboId: 1e21, cantidad: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cada item debe tener un comboId válido.");
    expect(comboFindManyMock).not.toHaveBeenCalled();
  });

  it("400 con un productId fuera de rango seguro (1e21), sin consultar productos", async () => {
    const res = await pedir([{ productId: 1e21, cantidad: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cada item debe tener un productId válido.");
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  // Dos líneas del mismo combo se cobraban bien, pero `agruparLineasOrden` y
  // `rankingCombos` suponen UNA línea por combo por orden: el detalle mostraba
  // "Kit × 1" con el triple de productos.
  it("400 si el mismo comboId aparece en dos líneas, sin consultar combos", async () => {
    const res = await pedir([
      { comboId: 3, cantidad: 1 },
      { comboId: 3, cantidad: 2 },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El combo 3 está repetido en el pedido: enviá una sola línea con la cantidad total.");
    expect(comboFindManyMock).not.toHaveBeenCalled();
  });
});

describe("POST /ordenes — combos", () => {
  it("400 si el combo referenciado no existe", async () => {
    const res = await pedir([{ comboId: 999, cantidad: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El combo 999 no existe.");
  });

  it("409 si el combo existe pero no está vigente", async () => {
    comboFindManyMock.mockResolvedValue([comboFixture({ activo: false })]);
    const res = await pedir([{ comboId: 3, cantidad: 1 }]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("El combo «Kit Living Cálido» ya no está disponible.");
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("409 si el combo está vigente pero uno de sus productos se ocultó", async () => {
    comboFindManyMock.mockResolvedValue([comboFixture({ lampara: { visibleEnCatalogo: false } })]);
    const res = await pedir([{ comboId: 3, cantidad: 1 }]);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("El combo «Kit Living Cálido» ya no está disponible.");
  });

  it("una orden solo de combos no consulta productos sueltos", async () => {
    comboFindManyMock.mockResolvedValue([comboFixture()]);

    const res = await pedir([{ comboId: 3, cantidad: 1 }]);

    expect(res.status).toBe(201);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("una orden sin combos no consulta combos", async () => {
    productFindManyMock.mockResolvedValue([LAMPARA]);

    const res = await pedir([{ productId: 1, cantidad: 1 }]);

    expect(res.status).toBe(201);
    expect(comboFindManyMock).not.toHaveBeenCalled();
  });

  it("expande el combo en filas por producto, con snapshots, y el total es el precio del combo", async () => {
    comboFindManyMock.mockResolvedValue([comboFixture()]);

    const res = await pedir([{ comboId: 3, cantidad: 1 }]);

    expect(res.status).toBe(201);
    expect(filasCreadas()).toEqual([
      {
        productId: 1, nombreProducto: "Lámpara", precioUnitario: "8500", precioListaUnitario: "10000",
        descuentoPorcentaje: 15, costoUnitario: "4000", cantidad: 2,
        comboId: 3, comboNombre: "Kit Living Cálido", comboCantidad: 1, comboPorcentaje: 15,
      },
      {
        productId: 2, nombreProducto: "Mesa", precioUnitario: "21250", precioListaUnitario: "25000",
        descuentoPorcentaje: 15, costoUnitario: "12000", cantidad: 1,
        comboId: 3, comboNombre: "Kit Living Cálido", comboCantidad: 1, comboPorcentaje: 15,
      },
    ]);
    const total = filasCreadas().reduce((t, f) => t + Number(f.precioUnitario) * f.cantidad, 0);
    expect(total).toBe(38250);
  });

  it("con resto de redondeo, las filas del combo suman EXACTO precioCombo × comboCantidad", async () => {
    // Lámpara 1001 × 2 y mesa 1003 × 1 con 15 %: por unidad 850,85 → 851 y
    // 852,55 → 853, que suman 2555, pero el combo vale 2554. El peso de resto
    // lo absorbe la mesa (cantidad 1): si la expansión no pasara por
    // `repartirPrecioCombo`, el total se iría un peso por combo.
    comboFindManyMock.mockResolvedValue([
      comboFixture({ lampara: { precio: 1001 }, mesa: { precio: 1003 } }),
    ]);

    const res = await pedir([{ comboId: 3, cantidad: 2 }]);

    expect(res.status).toBe(201);
    // precioSeparado = 1001 × 2 + 1003 = 3005; precioCombo = round(2554,25) = 2554.
    const total = filasCreadas().reduce((t, f) => t + Number(f.precioUnitario) * f.cantidad, 0);
    expect(total).toBe(2554 * 2);
    for (const fila of filasCreadas()) {
      expect(Number.isInteger(Number(fila.precioUnitario))).toBe(true);
    }
  });

  it("combo x 2: cada fila multiplica su cantidad y comboCantidad queda en 2", async () => {
    comboFindManyMock.mockResolvedValue([comboFixture()]);

    const res = await pedir([{ comboId: 3, cantidad: 2 }]);

    expect(res.status).toBe(201);
    const lampara = filasCreadas().find((f) => f.productId === 1);
    expect(lampara).toMatchObject({ cantidad: 4, comboCantidad: 2 });
  });

  it("combo + el mismo producto suelto: dos filas distintas, la suelta con snapshot de combo en null", async () => {
    comboFindManyMock.mockResolvedValue([comboFixture()]);
    productFindManyMock.mockResolvedValue([LAMPARA]);

    const res = await pedir([{ productId: 1, cantidad: 1 }, { comboId: 3, cantidad: 1 }]);

    expect(res.status).toBe(201);
    const filasLampara = filasCreadas().filter((f) => f.productId === 1);
    expect(filasLampara).toHaveLength(2);
    expect(filasLampara.find((f) => f.comboId === null)).toMatchObject({
      cantidad: 1, comboNombre: null, comboCantidad: null, comboPorcentaje: null,
    });
    expect(filasLampara.find((f) => f.comboId === 3).cantidad).toBe(2);
  });

  it(`400 si las filas YA EXPANDIDAS superan MAX_ITEMS_POR_ORDEN (${MAX_ITEMS_POR_ORDEN})`, async () => {
    // 99 líneas sueltas (dentro del tope crudo) + 1 combo de 2 productos = 101 filas.
    const sueltos = Array.from({ length: 99 }, (_, i) => ({ ...LAMPARA, id: 100 + i, nombre: `P${i}` }));
    productFindManyMock.mockResolvedValue(sueltos);
    comboFindManyMock.mockResolvedValue([comboFixture()]);

    const res = await pedir([
      ...sueltos.map((p) => ({ productId: p.id, cantidad: 1 })),
      { comboId: 3, cantidad: 1 },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Una orden no puede tener más de ${MAX_ITEMS_POR_ORDEN} items.`);
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST /ordenes — demanda agregada por producto (spec §6.3.3)", () => {
  it("stock justo: 1 lámpara suelta + 1 combo con 2 lámparas y stock 3 se acepta", async () => {
    comboFindManyMock.mockResolvedValue([comboFixture({ lampara: { stock: 3 } })]);
    productFindManyMock.mockResolvedValue([{ ...LAMPARA, stock: 3 }]);

    const res = await pedir([{ productId: 1, cantidad: 1 }, { comboId: 3, cantidad: 1 }]);

    expect(res.status).toBe(201);
  });

  it("stock insuficiente: la misma orden con stock 2 se rechaza aunque cada línea sola entre", async () => {
    comboFindManyMock.mockResolvedValue([comboFixture({ lampara: { stock: 2 } })]);
    productFindManyMock.mockResolvedValue([{ ...LAMPARA, stock: 2 }]);

    const res = await pedir([{ productId: 1, cantidad: 1 }, { comboId: 3, cantidad: 1 }]);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('No hay stock suficiente de "Lámpara": el pedido suma 3 y quedan 2.');
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("combo x 3 con mesa de stock 2: 409 nombrando la mesa", async () => {
    comboFindManyMock.mockResolvedValue([comboFixture({ mesa: { stock: 2 } })]);

    const res = await pedir([{ comboId: 3, cantidad: 3 }]);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('No hay stock suficiente de "Mesa": el pedido suma 3 y quedan 2.');
  });

  it("cambio de comportamiento: una orden SIN combos que pide más que el stock también es 409", async () => {
    productFindManyMock.mockResolvedValue([{ ...MESA, stock: 2 }]);

    const res = await pedir([{ productId: 2, cantidad: 3 }]);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('No hay stock suficiente de "Mesa": el pedido suma 3 y quedan 2.');
  });
});
