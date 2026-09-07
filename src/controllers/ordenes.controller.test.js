import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const clienteFindUniqueMock = vi.fn();
const clienteCreateMock = vi.fn();
const clienteUpdateMock = vi.fn();
const productFindManyMock = vi.fn();
const productFindUniqueMock = vi.fn();
const productUpdateMock = vi.fn();
const productUpdateManyMock = vi.fn();
const ordenCreateMock = vi.fn();
const ordenFindManyMock = vi.fn();
const ordenFindUniqueMock = vi.fn();
const ordenUpdateMock = vi.fn();
const ordenUpdateManyMock = vi.fn();
const ordenCountMock = vi.fn();
const ordenGroupByMock = vi.fn();
const eventoTraficoCreateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    // Sin promociones vigentes, que es el caso normal y el que deja el precio
    // igual al de lista. Ver `lib/precioEfectivo.js`.
    promocionItem: { findMany: async () => [] },
    cliente: {
      findUnique: (...args) => clienteFindUniqueMock(...args),
      create: (...args) => clienteCreateMock(...args),
      update: (...args) => clienteUpdateMock(...args),
    },
    product: {
      findMany: (...args) => productFindManyMock(...args),
      findUnique: (...args) => productFindUniqueMock(...args),
      update: (...args) => productUpdateMock(...args),
      updateMany: (...args) => productUpdateManyMock(...args),
    },
    orden: {
      create: (...args) => ordenCreateMock(...args),
      findMany: (...args) => ordenFindManyMock(...args),
      findUnique: (...args) => ordenFindUniqueMock(...args),
      update: (...args) => ordenUpdateMock(...args),
      updateMany: (...args) => ordenUpdateManyMock(...args),
      count: (...args) => ordenCountMock(...args),
      groupBy: (...args) => ordenGroupByMock(...args),
    },
    eventoTrafico: {
      create: (...args) => eventoTraficoCreateMock(...args),
    },
    $transaction: (...args) => transactionMock(...args),
  },
}));

const {
  crear,
  listar,
  resumen,
  obtenerPorId,
  actualizarEstado,
  MAX_ITEMS_POR_ORDEN,
  MAX_CANTIDAD_POR_ITEM,
} = await import("./ordenes.controller.js");
const { LISTADO_ORDEN_INCLUDE, DETALLE_ORDEN_INCLUDE } = await import("./ordenes.mapper.js");

function buildReqRes({ body, query, params } = {}) {
  const req = { body: body ?? {}, query: query ?? {}, params: params ?? {} };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      // Mirrors Express's real behavior: res.json() without a prior
      // res.status() call implicitly responds 200.
      if (this.statusCode === null) this.statusCode = 200;
      this.body = payload;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

const PRODUCTO_DISPONIBLE = {
  id: 1,
  nombre: "Producto A",
  precio: "100.00",
  visibleEnCatalogo: true,
  stock: 10,
};

const PRODUCTO_2_DISPONIBLE = {
  id: 2,
  nombre: "Producto B",
  precio: "50.00",
  visibleEnCatalogo: true,
  stock: 10,
};

const CLIENTE_EXISTENTE = {
  id: 10,
  dni: "12345678",
  nombre: "Juan Perez",
  telefono: "1122334455",
  email: "juan@test.com",
};

const ORDEN_CREADA_MOCK = {
  id: 100,
  clienteId: 10,
  estado: "PENDIENTE",
  notas: null,
  cliente: CLIENTE_EXISTENTE,
  items: [
    {
      id: 1,
      ordenId: 100,
      productId: 1,
      nombreProducto: "Producto A",
      precioUnitario: "100.00",
      cantidad: 2,
    },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Shape devuelta por listar(): cliente completo + las tres columnas de cada
// ítem que alimentan `total` y `resumen` (NO la línea entera) — ver nota en
// ordenes.controller.js sobre por qué el listado no trae el detalle completo.
const ORDEN_LISTADO_MOCK = {
  id: 100,
  clienteId: 10,
  estado: "PENDIENTE",
  notas: null,
  cliente: CLIENTE_EXISTENTE,
  items: [{ nombreProducto: "Producto A", precioUnitario: "100", cantidad: 1 }],
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** El mock de arriba, tal como lo publica `mapOrdenListado`. */
const ORDEN_LISTADO_ESPERADA = (() => {
  const { items: _items, ...resto } = ORDEN_LISTADO_MOCK;
  return {
    ...resto,
    estadoEtiqueta: "Pendiente",
    cantidadItems: 1,
    total: "100",
    resumen: [{ nombreProducto: "Producto A", cantidad: 1 }],
  };
})();

beforeEach(() => {
  clienteFindUniqueMock.mockReset();
  clienteCreateMock.mockReset();
  clienteUpdateMock.mockReset();
  productFindManyMock.mockReset();
  productFindUniqueMock.mockReset();
  productUpdateMock.mockReset();
  productUpdateManyMock.mockReset();
  ordenCreateMock.mockReset();
  ordenFindManyMock.mockReset();
  ordenFindUniqueMock.mockReset();
  ordenUpdateMock.mockReset();
  ordenUpdateManyMock.mockReset();
  ordenCountMock.mockReset();
  ordenGroupByMock.mockReset();
  eventoTraficoCreateMock.mockReset();
  transactionMock.mockReset();

  // Default: $transaction receives a callback and runs it against a `tx`
  // object shaped like `prisma`, mirroring how products.controller.js's
  // actualizar() transaction is tested/used in this codebase.
  transactionMock.mockImplementation(async (cb) => {
    const tx = {
      cliente: {
        findUnique: (...args) => clienteFindUniqueMock(...args),
        create: (...args) => clienteCreateMock(...args),
        update: (...args) => clienteUpdateMock(...args),
      },
      product: {
        findUnique: (...args) => productFindUniqueMock(...args),
        update: (...args) => productUpdateMock(...args),
        updateMany: (...args) => productUpdateManyMock(...args),
      },
      orden: {
        create: (...args) => ordenCreateMock(...args),
        findUnique: (...args) => ordenFindUniqueMock(...args),
        update: (...args) => ordenUpdateMock(...args),
        updateMany: (...args) => ordenUpdateManyMock(...args),
      },
    };
    return cb(tx);
  });

  // Por defecto el descuento guardado encuentra la fila y la actualiza; los
  // tests que simulan stock insuficiente devuelven `{ count: 0 }` a propósito.
  productUpdateManyMock.mockResolvedValue({ count: 1 });
  // Por defecto la escritura guardada de transición matchea la fila (la orden
  // NO tenía `stockDescontado: true`); los tests de carrera devuelven
  // `{ count: 0 }`.
  ordenUpdateManyMock.mockResolvedValue({ count: 1 });
  eventoTraficoCreateMock.mockResolvedValue({});
});

// El reloj falso se devuelve SIEMPRE, pase lo que pase en el test.
//
// Estaba como un `vi.useRealTimers()` en línea, en medio del cuerpo de los dos
// tests que congelan `Date`: si el código bajo test lanza (o si una expectativa
// falla antes de esa línea), la restauración nunca corre y el reloj falso se
// filtra al resto del archivo. El síntoma no aparece donde está la causa — falla
// otro test, más abajo, por una fecha que nadie le puso.
//
// Solo `Date` se faquea en este archivo (ver los tests del período): faquear
// todos los timers cuelga los tests que levantan un servidor HTTP real.
// `useRealTimers()` sobre un reloj que nunca se faqueó es un no-op, así que
// correrlo en cada test es gratis.
afterEach(() => {
  vi.useRealTimers();
});

function bodyValido(overrides = {}) {
  return {
    dni: "12.345.678",
    nombre: "Juan Perez",
    telefono: "1122334455",
    email: "juan@test.com",
    notas: "Entregar por la tarde",
    items: [{ productId: 1, cantidad: 2 }],
    ...overrides,
  };
}

describe("crear() — validación de campos requeridos", () => {
  it("responde 400 si falta dni", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ dni: undefined }) });
    await crear(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("responde 400 si falta nombre", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ nombre: "" }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 si falta telefono", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ telefono: "" }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 si items es un array vacío", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ items: [] }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("responde 400 si items no es un array", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ items: "no-array" }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 si falta items", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ items: undefined }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });
});

describe("crear() — validación de DNI", () => {
  it("responde 400 con DNI inválido (muy corto) antes de tocar la DB", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ dni: "123" }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(clienteFindUniqueMock).not.toHaveBeenCalled();
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("responde 400 con DNI inválido (muy largo)", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ dni: "123456789012" }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 con DNI que no tiene ningún dígito", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ dni: "abcdefgh" }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });
});

describe("crear() — validación de items", () => {
  it("responde 400 si un item tiene productId no numérico", async () => {
    const { req, res, next } = buildReqRes({
      body: bodyValido({ items: [{ productId: "abc", cantidad: 1 }] }),
    });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("responde 400 si un item tiene productId <= 0", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ items: [{ productId: 0, cantidad: 1 }] }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 si un item tiene cantidad <= 0", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ items: [{ productId: 1, cantidad: 0 }] }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("responde 400 si un item tiene cantidad negativa", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ items: [{ productId: 1, cantidad: -1 }] }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 si un item tiene cantidad no entera", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ items: [{ productId: 1, cantidad: 1.5 }] }) });
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });
});

describe("crear() — topes de items y cantidades (anti-abuso)", () => {
  it("exporta los topes con los valores acordados", () => {
    expect(MAX_ITEMS_POR_ORDEN).toBe(100);
    expect(MAX_CANTIDAD_POR_ITEM).toBe(999);
  });

  it("responde 400 si la orden trae más de MAX_ITEMS_POR_ORDEN items, sin tocar la DB", async () => {
    const items = Array.from({ length: 101 }, (_, i) => ({ productId: i + 1, cantidad: 1 }));
    const { req, res, next } = buildReqRes({ body: bodyValido({ items }) });

    await crear(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(productFindManyMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("responde 400 si un item pide más de MAX_CANTIDAD_POR_ITEM unidades, sin tocar la DB", async () => {
    const { req, res, next } = buildReqRes({ body: bodyValido({ items: [{ productId: 1, cantidad: 1000 }] }) });

    await crear(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("acepta una cantidad exactamente igual a MAX_CANTIDAD_POR_ITEM (999)", async () => {
    clienteFindUniqueMock.mockResolvedValue(CLIENTE_EXISTENTE);
    clienteUpdateMock.mockResolvedValue(CLIENTE_EXISTENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({ body: bodyValido({ items: [{ productId: 1, cantidad: 999 }] }) });
    await crear(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
  });

  it("acepta una orden con exactamente MAX_ITEMS_POR_ORDEN items (100)", async () => {
    const productos = Array.from({ length: 100 }, (_, i) => ({
      ...PRODUCTO_DISPONIBLE,
      id: i + 1,
      nombre: `Producto ${i + 1}`,
    }));
    clienteFindUniqueMock.mockResolvedValue(CLIENTE_EXISTENTE);
    clienteUpdateMock.mockResolvedValue(CLIENTE_EXISTENTE);
    productFindManyMock.mockResolvedValue(productos);
    ordenCreateMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const items = Array.from({ length: 100 }, (_, i) => ({ productId: i + 1, cantidad: 1 }));
    const { req, res, next } = buildReqRes({ body: bodyValido({ items }) });
    await crear(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
  });
});

describe("crear() — validación de productos contra la DB", () => {
  it("responde 400 si algún productId no existe, y no crea la orden (whole request rejected)", async () => {
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]); // solo vuelve 1 de los 2 pedidos
    const { req, res, next } = buildReqRes({
      body: bodyValido({
        items: [
          { productId: 1, cantidad: 1 },
          { productId: 999, cantidad: 1 },
        ],
      }),
    });

    await crear(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("responde 400 si un producto está agotado (stock 0), y no crea la orden", async () => {
    productFindManyMock.mockResolvedValue([{ ...PRODUCTO_DISPONIBLE, stock: 0 }]);
    const { req, res, next } = buildReqRes({ body: bodyValido({ items: [{ productId: 1, cantidad: 1 }] }) });

    await crear(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("responde 400 si un producto tiene visibleEnCatalogo false, y no crea la orden", async () => {
    productFindManyMock.mockResolvedValue([{ ...PRODUCTO_DISPONIBLE, visibleEnCatalogo: false }]);
    const { req, res, next } = buildReqRes({ body: bodyValido({ items: [{ productId: 1, cantidad: 1 }] }) });

    await crear(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });
});

describe("crear() — cliente nuevo", () => {
  it("crea un Cliente nuevo y la Orden cuando el DNI no existe", async () => {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE_EXISTENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({ body: bodyValido() });
    await crear(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(clienteCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dni: "12345678",
          nombre: "Juan Perez",
          telefono: "1122334455",
          email: "juan@test.com",
        }),
      }),
    );
    expect(res.body.cliente).toBeDefined();
    expect(res.body.items).toBeDefined();
  });
});

describe("crear() — cliente existente reutilizado", () => {
  it("reutiliza el cliente existente y actualiza sus datos (no lo duplica)", async () => {
    clienteFindUniqueMock.mockResolvedValue(CLIENTE_EXISTENTE);
    clienteUpdateMock.mockResolvedValue({
      ...CLIENTE_EXISTENTE,
      nombre: "Juan Perez Actualizado",
      telefono: "1199999999",
    });
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({
      body: bodyValido({ nombre: "Juan Perez Actualizado", telefono: "1199999999" }),
    });
    await crear(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(clienteCreateMock).not.toHaveBeenCalled();
    expect(clienteUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { dni: "12345678" },
        data: expect.objectContaining({
          nombre: "Juan Perez Actualizado",
          telefono: "1199999999",
        }),
      }),
    );
    expect(res.statusCode).toBe(201);
  });

  it("normaliza el DNI antes de buscar/actualizar: '12.345.678' encuentra al mismo cliente que '12345678'", async () => {
    clienteFindUniqueMock.mockResolvedValue(CLIENTE_EXISTENTE);
    clienteUpdateMock.mockResolvedValue(CLIENTE_EXISTENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({ body: bodyValido({ dni: "12.345.678" }) });
    await crear(req, res, next);

    expect(clienteFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { dni: "12345678" } }));
    expect(res.statusCode).toBe(201);
  });
});

describe("crear() — snapshot de precio y nombre (invariante permanente)", () => {
  it("usa el precio/nombre del producto AL MOMENTO de la orden, y no se recalcula si el producto muta después", async () => {
    // Mutable product object simulating what would happen if the live
    // Product row changed AFTER this order was created — the snapshot taken
    // during crear() must have already captured the ORIGINAL values, and the
    // create() call args must never be re-read after mutation.
    const productoMutable = { ...PRODUCTO_DISPONIBLE, nombre: "Producto A", precio: "100.00" };
    clienteFindUniqueMock.mockResolvedValue(CLIENTE_EXISTENTE);
    clienteUpdateMock.mockResolvedValue(CLIENTE_EXISTENTE);
    productFindManyMock.mockResolvedValue([productoMutable]);
    ordenCreateMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({ body: bodyValido({ items: [{ productId: 1, cantidad: 3 }] }) });
    await crear(req, res, next);

    expect(ordenCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          items: expect.objectContaining({
            create: [
              expect.objectContaining({
                productId: 1,
                nombreProducto: "Producto A",
                precioUnitario: "100.00",
                cantidad: 3,
              }),
            ],
          }),
        }),
      }),
    );

    // Mutate the product AFTER order creation — this must NOT retroactively
    // change what was already sent to ordenCreateMock (permanent guardrail:
    // ItemOrden.precioUnitario/nombreProducto are snapshots, never recalculated).
    productoMutable.nombre = "Producto A RENOMBRADO";
    productoMutable.precio = "999.00";

    const callArgs = ordenCreateMock.mock.calls[0][0];
    expect(callArgs.data.items.create[0].nombreProducto).toBe("Producto A");
    expect(callArgs.data.items.create[0].precioUnitario).toBe("100.00");
  });

  it("soporta múltiples items, cada uno con su propio snapshot", async () => {
    clienteFindUniqueMock.mockResolvedValue(CLIENTE_EXISTENTE);
    clienteUpdateMock.mockResolvedValue(CLIENTE_EXISTENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE, PRODUCTO_2_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({
      body: bodyValido({
        items: [
          { productId: 1, cantidad: 2 },
          { productId: 2, cantidad: 5 },
        ],
      }),
    });
    await crear(req, res, next);

    const callArgs = ordenCreateMock.mock.calls[0][0];
    expect(callArgs.data.items.create).toHaveLength(2);
    expect(callArgs.data.items.create).toContainEqual(
      expect.objectContaining({ productId: 1, nombreProducto: "Producto A", precioUnitario: "100.00", cantidad: 2 }),
    );
    expect(callArgs.data.items.create).toContainEqual(
      expect.objectContaining({ productId: 2, nombreProducto: "Producto B", precioUnitario: "50.00", cantidad: 5 }),
    );
  });
});

describe("crear() — concurrencia (retry-on-P2002 para dni)", () => {
  it("dos requests simultáneos con el mismo DNI nuevo no duplican el Cliente: reintenta con findUnique tras P2002", async () => {
    const errorColisionDni = Object.assign(new Error("Unique constraint failed"), {
      code: "P2002",
      meta: { target: ["dni"] },
    });

    // First lookup: no client yet (both requests race past this check).
    // create() throws P2002 (the other request won the race and created it
    // first). Retry loop then re-fetches via findUnique and proceeds with
    // that row instead of failing the whole request.
    clienteFindUniqueMock.mockResolvedValueOnce(null).mockResolvedValueOnce(CLIENTE_EXISTENTE);
    clienteCreateMock.mockRejectedValueOnce(errorColisionDni);
    clienteUpdateMock.mockResolvedValue(CLIENTE_EXISTENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({ body: bodyValido() });
    await crear(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(clienteCreateMock).toHaveBeenCalledTimes(1);
    expect(clienteFindUniqueMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(201);
  });
});

describe("crear() — evento ORDEN_CREADA no bloquea la respuesta", () => {
  it("responde 201 igual si prisma.eventoTrafico.create falla", async () => {
    clienteFindUniqueMock.mockResolvedValue(CLIENTE_EXISTENTE);
    clienteUpdateMock.mockResolvedValue(CLIENTE_EXISTENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN_CREADA_MOCK);
    eventoTraficoCreateMock.mockRejectedValue(new Error("DB caída"));

    const { req, res, next } = buildReqRes({ body: bodyValido() });
    await crear(req, res, next);

    // Give any un-awaited fire-and-forget promise a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
  });
});

describe("crear() — respuesta 201", () => {
  it("incluye cliente e items en la respuesta", async () => {
    clienteFindUniqueMock.mockResolvedValue(CLIENTE_EXISTENTE);
    clienteUpdateMock.mockResolvedValue(CLIENTE_EXISTENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({ body: bodyValido() });
    await crear(req, res, next);

    expect(res.statusCode).toBe(201);
    expect(res.body.cliente).toEqual(CLIENTE_EXISTENTE);
    expect(res.body.items).toEqual(ORDEN_CREADA_MOCK.items);
  });
});

describe("listar()", () => {
  it("lista órdenes ordenadas por createdAt desc, con el include del listado", async () => {
    ordenFindManyMock.mockResolvedValue([ORDEN_LISTADO_MOCK]);
    ordenCountMock.mockResolvedValue(1);

    const { req, res, next } = buildReqRes();
    await listar(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    // Se afirma por IDENTIDAD contra la constante del mapper, no copiando el
    // objeto: así el test no puede quedar describiendo un include que el
    // controller ya no usa.
    expect(ordenFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
        include: LISTADO_ORDEN_INCLUDE,
      }),
    );
    expect(res.body.data).toEqual([ORDEN_LISTADO_ESPERADA]);
    expect(res.body.total).toBe(1);
  });

  it("emite el monto total y el resumen de cada orden", async () => {
    ordenFindManyMock.mockResolvedValue([ORDEN_LISTADO_MOCK]);
    ordenCountMock.mockResolvedValue(1);

    const { req, res, next } = buildReqRes();
    await listar(req, res, next);

    expect(res.body.data[0].total).toBe("100");
    expect(res.body.data[0].cantidadItems).toBe(1);
    expect(res.body.data[0].resumen).toEqual([{ nombreProducto: "Producto A", cantidad: 1 }]);
  });

  it("NO emite las líneas de la orden ni el _count", async () => {
    // El guard de que `precioUnitario` renglón por renglón no se filtra a una
    // grilla. `_count` desaparece porque `cantidadItems` lo reemplaza.
    ordenFindManyMock.mockResolvedValue([{ ...ORDEN_LISTADO_MOCK, _count: { items: 1 } }]);
    ordenCountMock.mockResolvedValue(1);

    const { req, res, next } = buildReqRes();
    await listar(req, res, next);

    expect(res.body.data[0].items).toBeUndefined();
    expect(res.body.data[0]._count).toBeUndefined();
  });

  it("filtra por estado exacto", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { estado: "EN_PREPARACION" } });
    await listar(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(ordenFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ estado: "EN_PREPARACION" }) }),
    );
  });

  it("ignora un estado con valor inválido (no filtra, no rompe)", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { estado: "NO_EXISTE" } });
    await listar(req, res, next);

    expect(res.statusCode).toBe(200);
    const whereUsado = ordenFindManyMock.mock.calls[0][0].where ?? {};
    expect(whereUsado.estado).toBeUndefined();
  });

  it("filtra por rango de fechas (desde/hasta) sobre createdAt", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({
      query: { desde: "2026-01-01", hasta: "2026-01-31" },
    });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where;
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeInstanceOf(Date);
  });

  // CAMBIÓ DE EXPECTATIVA (no es una regresión, es la semántica nueva): antes
  // cada extremo se parseaba por separado, así que `desde` solo dejaba `lte`
  // sin definir y el listado se comía todo el futuro. Ahora el rango lo arma
  // `parsearPeriodo`, que SIEMPRE devuelve los dos extremos: sin `hasta`, el
  // período termina hoy.
  it("filtra solo por desde: el período igual queda cerrado en los dos extremos", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    // El reloj se CONGELA para poder clavar el instante exacto del `lte`. Con
    // `toBeInstanceOf(Date)` a secas —como estaba— un `lte` mal calculado
    // (medianoche UTC en vez del fin del día argentino, o el día equivocado)
    // pasaba el test igual: cualquier Date lo satisface, incluso un Invalid
    // Date. El test hermano de acá abajo sí clava el instante, así que el hueco
    // era justo el extremo que este endpoint calcula solo.
    //
    // 02/09/2026 01:00 UTC = 01/09/2026 22:00 en Argentina: el "hoy" argentino
    // es el 01, no el 02. Es la franja nocturna donde los dos calendarios
    // difieren, o sea donde un `lte` armado con el día UTC se delata.
    //
    // Solo `Date`: faquear todos los timers cuelga los tests que levantan un
    // servidor HTTP real (ver la nota de `afterEach`).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T01:00:00.000Z"));

    const { req, res, next } = buildReqRes({ query: { desde: "2026-08-01" } });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where;
    expect(where.createdAt.gte).toEqual(new Date("2026-08-01T03:00:00.000Z"));
    // Fin del día argentino de HOY (01/09), o sea las 02:59:59.999 UTC del 02.
    expect(where.createdAt.lte).toEqual(new Date("2026-09-02T02:59:59.999Z"));
    expect(res.body.periodo).toEqual({
      desde: "2026-08-01",
      hasta: "2026-09-01",
      recortado: false,
    });
  });

  // LA DECISIÓN, fijada acá porque el docstring solo no la puede sostener: una
  // fecha ILEGIBLE se trata como AUSENTE. No acota nada, no tira 400 y la
  // respuesta no trae `periodo`.
  //
  // Antes caía al default de 30 días, y eso NO es "ignorar el filtro": es
  // cambiar el universo de resultados. Un link compartido con un typo en la
  // fecha escondía el histórico entero, con 200, sin `recortado: true` y sin
  // una sola señal — en una pantalla que RESPONDE "¿hay órdenes?", eso le
  // afirma al operador algo falso.
  //
  // Es además el criterio que ya aplica el resto del repo: en
  // `products.controller.js`'s `construirFiltrosListado`, un `?categoria=abc`,
  // un `?etiqueta=abc` o un `?promocion=abc` NO arman filtro. Ninguno cae a un
  // default que recorte.
  it("una fecha ILEGIBLE se trata como ausente: no acota el período", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { desde: "no-es-fecha" } });
    await listar(req, res, next);

    expect(res.statusCode).toBe(200);
    const where = ordenFindManyMock.mock.calls[0][0].where ?? {};
    expect(where.createdAt).toBeUndefined();
    expect(res.body).not.toHaveProperty("periodo");
  });

  it("una fecha ilegible en `hasta` tampoco acota el período", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { hasta: "31/01/2026" } });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where ?? {};
    expect(where.createdAt).toBeUndefined();
  });

  // El otro lado de la misma asimetría: `parsearPeriodo` ya trataba `""` como
  // ausente, pero la guarda del listado miraba `!== undefined`, así que la
  // clave vacía la daba por presente y disparaba el default de 30 días. Dos
  // funciones que TIENEN que estar de acuerdo y no lo estaban.
  //
  // La pantalla no lo dispara (mapea `"" → undefined`), así que el expuesto era
  // cualquier otro consumidor de la API o una URL editada a mano — justamente
  // el caso que nadie mira.
  it("`?desde=` vacío se trata como ausente, no como período de 30 días", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { desde: "" } });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where ?? {};
    expect(where.createdAt).toBeUndefined();
    expect(res.body).not.toHaveProperty("periodo");
  });

  it("`?hasta=` vacío se trata como ausente", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { hasta: "" } });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where ?? {};
    expect(where.createdAt).toBeUndefined();
  });

  it("`?dias=` vacío o no numérico se trata como ausente", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    for (const dias of ["", "abc", "0", "-5", "2.5"]) {
      ordenFindManyMock.mockClear();
      const { req, res, next } = buildReqRes({ query: { dias } });
      await listar(req, res, next);

      const where = ordenFindManyMock.mock.calls[0][0].where ?? {};
      expect(where.createdAt, `?dias=${dias} no debería acotar el período`).toBeUndefined();
      expect(res.body).not.toHaveProperty("periodo");
    }
  });

  // El complemento: un valor ILEGIBLE se ignora, pero uno LEGIBLE sigue
  // acotando aunque venga acompañado de basura. La guarda mira si hay al menos
  // un parámetro de rango utilizable, no si la query trae alguna clave.
  it("un `desde` legible sigue acotando aunque `dias` venga ilegible", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({
      query: { desde: "2026-08-01", hasta: "2026-08-15", dias: "abc" },
    });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where;
    expect(where.createdAt.gte).toEqual(new Date("2026-08-01T03:00:00.000Z"));
    expect(res.body.periodo).toMatchObject({ desde: "2026-08-01", hasta: "2026-08-15" });
  });

  it("filtra por dni del cliente (relation filter)", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { dni: "12.345.678" } });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where;
    // El dni se normaliza antes de filtrar, igual que en crear().
    expect(where.cliente).toEqual(expect.objectContaining({ dni: "12345678" }));
  });

  it("filtra por nombre del cliente (relation filter, contains)", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { nombre: "Juan" } });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where;
    expect(where.cliente).toEqual(expect.objectContaining({ nombre: { contains: "Juan" } }));
  });

  it("combina múltiples filtros a la vez", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({
      query: { estado: "PENDIENTE", dni: "12345678", nombre: "Juan", desde: "2026-01-01" },
    });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where;
    expect(where.estado).toBe("PENDIENTE");
    expect(where.cliente).toEqual(expect.objectContaining({ dni: "12345678", nombre: { contains: "Juan" } }));
    expect(where.createdAt.gte).toBeInstanceOf(Date);
  });

  it("usa page y pageSize de la query string para paginar", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { page: "2", pageSize: "5" } });
    await listar(req, res, next);

    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(5);
    expect(ordenFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ skip: 5, take: 5 }));
  });

  it("clampea pageSize por encima del máximo permitido", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { pageSize: "999999" } });
    await listar(req, res, next);

    expect(res.body.pageSize).toBe(100);
    expect(ordenFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ take: 100 }));
  });

  it("usa el default si page/pageSize son inválidos, sin tirar 500", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { page: "abc", pageSize: "-3" } });
    await listar(req, res, next);

    expect(res.statusCode).toBe(200);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
  });
});

describe("listar() — el período lo resuelve parsearPeriodo", () => {
  // POR QUÉ EXISTE ESTE BLOQUE. El listado parseaba `desde`/`hasta` a mano con
  // `new Date(...)` y tenía dos bugs que nada delataba: `hasta` era exclusivo de
  // hecho (`new Date("2026-01-31")` es medianoche UTC, así que con `lte` se
  // perdía el día 31 entero) y los cortes caían a las 21:00 ART del día
  // anterior, porque el calendario era el de Greenwich y el negocio vive en
  // Buenos Aires. Los dos los resuelve `parsearPeriodo`, que ya es la única casa
  // del calendario argentino — escribir un tercer parser acá sería una segunda
  // definición de "día" que se desincroniza sin que nada falle.

  it("sin ningún parámetro de fecha NO filtra por createdAt", async () => {
    // EL GUARD MÁS CARO DE ESTE CAMBIO. `parsearPeriodo` SIEMPRE devuelve un
    // rango (30 días por defecto), así que aplicarlo sin condición dejaría
    // `GET /ordenes` devolviendo solo el último mes: el preset "Todo" de la
    // pantalla mostraría menos órdenes de las que hay, con 200 y sin error.
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { estado: "PENDIENTE" } });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where ?? {};
    expect(where.createdAt).toBeUndefined();
  });

  it("`hasta` es INCLUSIVO: cubre hasta el final de ese día argentino", async () => {
    // El bug del último día. `new Date("2026-01-31")` es el 31 a las 00:00 UTC,
    // o sea las 21:00 del 30 en Argentina: con `lte` se perdían las órdenes del
    // 31 entero y las de la noche del 30. El límite tiene que ser el final del
    // día ARGENTINO, o sea las 02:59:59.999 UTC del 1 de febrero.
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({
      query: { desde: "2026-01-01", hasta: "2026-01-31" },
    });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where;
    expect(where.createdAt.gte).toEqual(new Date("2026-01-01T03:00:00.000Z"));
    expect(where.createdAt.lte).toEqual(new Date("2026-02-01T02:59:59.999Z"));

    // Una orden creada el 31 a las 20:00 ART (23:00 UTC) entra en el rango. Es
    // el caso concreto que el parser viejo se comía.
    const orden20hs = new Date("2026-01-31T23:00:00.000Z");
    expect(orden20hs.getTime()).toBeGreaterThanOrEqual(where.createdAt.gte.getTime());
    expect(orden20hs.getTime()).toBeLessThanOrEqual(where.createdAt.lte.getTime());
  });

  it("`?dias=7` arma el rango sin que vengan desde/hasta", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    // 02/09/2026 01:00 UTC = 01/09/2026 22:00 en Argentina: el "hoy" argentino
    // es el 01, no el 02. Es justo la franja nocturna donde los dos calendarios
    // difieren, así que si el rango sale bien acá, sale del correcto.
    //
    // Solo `Date`: faquear todos los timers cuelga los tests que levantan un
    // servidor HTTP real, y el hábito se respeta también acá.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T01:00:00.000Z"));

    const { req, res, next } = buildReqRes({ query: { dias: "7" } });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where;
    expect(where.createdAt.gte).toEqual(new Date("2026-08-26T03:00:00.000Z"));
    expect(res.body.periodo).toMatchObject({ desde: "2026-08-26", hasta: "2026-09-01" });
  });

  it("desde/hasta explícitos ganan sobre dias", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({
      query: { dias: "7", desde: "2026-08-01", hasta: "2026-08-15" },
    });
    await listar(req, res, next);

    expect(res.body.periodo).toMatchObject({ desde: "2026-08-01", hasta: "2026-08-15" });
  });

  it("un rango mayor al tope se recorta y la respuesta lo declara", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({
      query: { desde: "2020-01-01", hasta: "2030-01-01" },
    });
    await listar(req, res, next);

    // Se conserva `hasta` y se corre `desde`: ante un rango imposible interesa
    // el tramo más reciente, no el arranque histórico.
    expect(res.body.periodo.hasta).toBe("2030-01-01");
    expect(res.body.periodo.recortado).toBe(true);
  });

  it("sin período la respuesta NO trae la clave `periodo`", async () => {
    // El sobre del listado sigue siendo el de siempre cuando nadie acotó nada:
    // emitir un `periodo` inventado le diría a la pantalla que hay un rango
    // aplicado cuando está mostrando el histórico completo.
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes();
    await listar(req, res, next);

    expect(res.body).not.toHaveProperty("periodo");
  });

  it("con período la respuesta trae `periodo` con claves YYYY-MM-DD", async () => {
    // Misma forma exacta que emiten las cuatro pantallas de analytics, para que
    // el aviso de período recortado del panel sea el mismo componente.
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({
      query: { desde: "2026-08-01", hasta: "2026-08-15" },
    });
    await listar(req, res, next);

    expect(res.body.periodo).toEqual({
      desde: "2026-08-01",
      hasta: "2026-08-15",
      recortado: false,
    });
  });
});

describe("resumen()", () => {
  it("devuelve los cuatro estados aunque groupBy traiga menos", async () => {
    // `groupBy` OMITE los estados sin ninguna fila — no los devuelve en cero.
    // Sin sembrar el objeto con los cuatro de `ESTADOS_ORDEN`, un estado ausente
    // llegaría como `undefined` y la columna del tablero leería "no existe" en
    // vez de "ninguna": el contador quedaría vacío en vez de decir 0.
    ordenGroupByMock.mockResolvedValue([
      { estado: "PENDIENTE", _count: { _all: 3 } },
      { estado: "ENTREGADA", _count: { _all: 7 } },
    ]);

    const { req, res, next } = buildReqRes();
    await resumen(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      PENDIENTE: 3,
      EN_PREPARACION: 0,
      ENTREGADA: 7,
      CANCELADA: 0,
    });
  });

  it("cuenta con UNA sola consulta agrupada, no una por estado", async () => {
    ordenGroupByMock.mockResolvedValue([]);

    const { req, res, next } = buildReqRes();
    await resumen(req, res, next);

    expect(ordenGroupByMock).toHaveBeenCalledTimes(1);
    expect(ordenGroupByMock).toHaveBeenCalledWith(
      expect.objectContaining({ by: ["estado"], _count: { _all: true } }),
    );
  });

  it("IGNORA el filtro por estado", async () => {
    // Si lo respetara, cada número sería el de su propio filtro y los otros
    // tres saldrían en 0: el tablero mostraría una sola columna con contenido.
    ordenGroupByMock.mockResolvedValue([]);

    const { req, res, next } = buildReqRes({ query: { estado: "ENTREGADA" } });
    await resumen(req, res, next);

    const where = ordenGroupByMock.mock.calls[0][0].where ?? {};
    expect(where.estado).toBeUndefined();
  });

  it("SÍ respeta desde/hasta, dni y nombre — los mismos filtros del listado", async () => {
    ordenGroupByMock.mockResolvedValue([]);

    const { req, res, next } = buildReqRes({
      query: { estado: "ENTREGADA", desde: "2026-08-01", hasta: "2026-08-15", dni: "12.345.678", nombre: "Juan" },
    });
    await resumen(req, res, next);

    const { where } = ordenGroupByMock.mock.calls[0][0];
    expect(where.createdAt.gte).toEqual(new Date("2026-08-01T03:00:00.000Z"));
    expect(where.createdAt.lte).toEqual(new Date("2026-08-16T02:59:59.999Z"));
    expect(where.cliente).toEqual({ dni: "12345678", nombre: { contains: "Juan" } });
  });

  it("sin filtros de fecha NO acota el período", async () => {
    // El mismo guard que el listado: `parsearPeriodo` siempre devuelve un rango,
    // así que sin la guarda los contadores del tablero contarían solo el último
    // mes y no coincidirían con el `total` de cada columna.
    ordenGroupByMock.mockResolvedValue([]);

    const { req, res, next } = buildReqRes();
    await resumen(req, res, next);

    const where = ordenGroupByMock.mock.calls[0][0].where ?? {};
    expect(where.createdAt).toBeUndefined();
  });

  // Los contadores comparten `construirFiltrosOrdenes` con el listado, así que
  // comparten también la decisión sobre las fechas ilegibles: si acá cayera al
  // default de 30 días mientras el listado muestra el histórico completo, cada
  // columna del tablero contaría un universo distinto del de su propia grilla.
  it("una fecha ilegible o vacía tampoco acota el período", async () => {
    ordenGroupByMock.mockResolvedValue([]);

    for (const query of [{ desde: "no-es-fecha" }, { desde: "" }, { dias: "" }]) {
      ordenGroupByMock.mockClear();
      const { req, res, next } = buildReqRes({ query });
      await resumen(req, res, next);

      const where = ordenGroupByMock.mock.calls[0][0].where ?? {};
      expect(where.createdAt, `${JSON.stringify(query)} no debería acotar`).toBeUndefined();
    }
  });

  // EL GUARD DEL FILTRO DE ESTADOS DESCONOCIDOS. `Orden.estado` es un
  // `VarChar(20)` sin enum de base, así que la columna puede traer un valor que
  // este sistema ya no conoce — `CONFIRMADA` existió hasta el 01/09/2026 y una
  // migración a medio aplicar lo deja vivo en la base.
  //
  // Sin este test, borrar el `ESTADOS_ORDEN.includes(...)` del controller dejaba
  // la suite entera en verde y la respuesta pasaba a emitir una quinta clave que
  // el tablero no sabe dibujar. Un guard que no puede fallar cuando la regla se
  // rompe no es un guard.
  it("DESCARTA un estado que no está en ESTADOS_ORDEN", async () => {
    ordenGroupByMock.mockResolvedValue([
      { estado: "PENDIENTE", _count: { _all: 3 } },
      { estado: "CONFIRMADA", _count: { _all: 9 } },
    ]);

    const { req, res, next } = buildReqRes();
    await resumen(req, res, next);

    expect(res.body).not.toHaveProperty("CONFIRMADA");
    expect(Object.keys(res.body)).toEqual([
      "PENDIENTE",
      "EN_PREPARACION",
      "ENTREGADA",
      "CANCELADA",
    ]);
    expect(res.body).toEqual({
      PENDIENTE: 3,
      EN_PREPARACION: 0,
      ENTREGADA: 0,
      CANCELADA: 0,
    });
  });

  // El mismo guard, contra la otra forma de romperlo: `in` en vez de `includes`
  // consulta la cadena de prototipos, así que un estado llamado `toString`
  // pasaría la condición y escribiría una clave heredada en la respuesta.
  it("DESCARTA un estado que colisiona con una propiedad del prototipo", async () => {
    ordenGroupByMock.mockResolvedValue([{ estado: "toString", _count: { _all: 4 } }]);

    const { req, res, next } = buildReqRes();
    await resumen(req, res, next);

    expect(Object.keys(res.body)).toEqual([
      "PENDIENTE",
      "EN_PREPARACION",
      "ENTREGADA",
      "CANCELADA",
    ]);
  });
});

describe("obtenerPorId()", () => {
  it("devuelve la orden con cliente e items", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({ params: { id: "100" } });
    await obtenerPorId(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(ordenFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        include: DETALLE_ORDEN_INCLUDE,
      }),
    );
    expect(res.statusCode).toBe(200);
    // La respuesta pasa ahora por `mapOrden(..., { esAdmin: true })`: además de
    // `estadoEtiqueta`, cada item emite `costoUnitario` normalizado (null si el
    // dato no existe) — es el contrato admin documentado del mapper.
    expect(res.body).toEqual({
      ...ORDEN_CREADA_MOCK,
      estadoEtiqueta: "Pendiente",
      items: ORDEN_CREADA_MOCK.items.map((item) => ({ costoUnitario: null, ...item })),
    });
  });

  it("emite la portada de cada ítem cuando el producto la tiene", async () => {
    const item = {
      ...ORDEN_CREADA_MOCK.items[0],
      product: { fotos: [{ url: "https://res.cloudinary.com/demo/a.jpg" }] },
    };
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, items: [item] });

    const { req, res, next } = buildReqRes({ params: { id: "100" } });
    await obtenerPorId(req, res, next);

    expect(res.body.items[0].fotoPortada).toBe("https://res.cloudinary.com/demo/a.jpg");
    expect(res.body.items[0]).not.toHaveProperty("product");
  });

  it("emite fotoPortada null cuando el producto fue borrado", async () => {
    // `onDelete: SetNull` desliga la línea: Prisma devuelve `product: null` y
    // la orden sigue siendo legible por sus snapshots. Tiene que responder 200,
    // no reventar.
    const item = { ...ORDEN_CREADA_MOCK.items[0], productId: null, product: null };
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, items: [item] });

    const { req, res, next } = buildReqRes({ params: { id: "100" } });
    await obtenerPorId(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.items[0].fotoPortada).toBeNull();
  });

  it("responde 404 si la orden no existe", async () => {
    ordenFindUniqueMock.mockResolvedValue(null);

    const { req, res, next } = buildReqRes({ params: { id: "999" } });
    await obtenerPorId(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(404);
    expect(res.statusCode).toBeNull();
  });

  it("responde 404 si el id no es un número válido", async () => {
    const { req, res, next } = buildReqRes({ params: { id: "abc" } });
    await obtenerPorId(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(404);
    expect(ordenFindUniqueMock).not.toHaveBeenCalled();
  });
});

describe("actualizarEstado()", () => {
  it("actualiza el estado a un valor válido", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN_CREADA_MOCK);
    productFindUniqueMock.mockResolvedValue({ ...PRODUCTO_DISPONIBLE, stock: 10 });
    productUpdateMock.mockResolvedValue({});
    ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(ordenUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        data: { estado: "EN_PREPARACION" },
        include: DETALLE_ORDEN_INCLUDE,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.estado).toBe("EN_PREPARACION");
  });

  it("usa EL MISMO include que el detalle, no uno propio", async () => {
    // ⚠️ El guard de la trampa central de esta feature. `AdminOrdenDetalle`
    // hace `setOrden(respuesta)` con lo que devuelve este PATCH: si este
    // include diverge del de `obtenerPorId`, las miniaturas de los productos
    // se ven al abrir la orden y DESAPARECEN al cambiarle el estado. Sin
    // error, sin test rojo — salvo este.
    //
    // Se afirma por IDENTIDAD de referencia contra la constante compartida:
    // una copia estructural del objeto dejaría pasar exactamente la
    // divergencia que este test existe para impedir.
    ordenFindUniqueMock.mockResolvedValue(ORDEN_CREADA_MOCK);
    ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
    await actualizarEstado(req, res, next);

    expect(ordenUpdateMock.mock.calls[0][0].include).toBe(DETALLE_ORDEN_INCLUDE);
  });

  it("emite la portada de cada ítem en la respuesta", async () => {
    const item = {
      ...ORDEN_CREADA_MOCK.items[0],
      product: { fotos: [{ url: "https://res.cloudinary.com/demo/a.jpg" }] },
    };
    ordenFindUniqueMock.mockResolvedValue(ORDEN_CREADA_MOCK);
    ordenUpdateMock.mockResolvedValue({
      ...ORDEN_CREADA_MOCK,
      estado: "EN_PREPARACION",
      items: [item],
    });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
    await actualizarEstado(req, res, next);

    expect(res.body.items[0].fotoPortada).toBe("https://res.cloudinary.com/demo/a.jpg");
  });

  describe("descuento de stock al confirmar", () => {
    it("pasar de PENDIENTE a EN_PREPARACION descuenta cantidad del stock de cada producto de la orden", async () => {
      const ordenDosItems = {
        ...ORDEN_CREADA_MOCK,
        estado: "PENDIENTE",
        items: [
          { id: 1, ordenId: 100, productId: 1, nombreProducto: "Producto A", precioUnitario: "100.00", cantidad: 2 },
          { id: 2, ordenId: 100, productId: 2, nombreProducto: "Producto B", precioUnitario: "50.00", cantidad: 3 },
        ],
      };
      ordenFindUniqueMock.mockResolvedValue(ordenDosItems);
      productFindUniqueMock.mockImplementation(({ where: { id } }) =>
        Promise.resolve(id === 1 ? { ...PRODUCTO_DISPONIBLE, stock: 10 } : { ...PRODUCTO_2_DISPONIBLE, stock: 10 }),
      );
      ordenUpdateMock.mockResolvedValue({ ...ordenDosItems, estado: "EN_PREPARACION" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      // Descuento atómico: la resta la hace la base sobre el valor vigente de
      // la fila, no el proceso sobre un valor leído antes. Un leer-restar-
      // escribir pierde el descuento de una confirmación concurrente.
      expect(productUpdateManyMock).toHaveBeenCalledWith({
        where: { id: 1, stock: { gte: 2 } },
        data: { stock: { decrement: 2 } },
      });
      expect(productUpdateManyMock).toHaveBeenCalledWith({
        where: { id: 2, stock: { gte: 3 } },
        data: { stock: { decrement: 3 } },
      });
      expect(res.statusCode).toBe(200);
    });

    it("pasar de EN_PREPARACION a EN_PREPARACION de nuevo no vuelve a descontar stock", async () => {
      ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });
      // La escritura guardada no matchea ninguna fila: la orden ya tenía
      // `stockDescontado: true`, así que la guarda (`stockDescontado: false`)
      // no encuentra nada.
      ordenUpdateManyMock.mockResolvedValue({ count: 0 });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(productFindUniqueMock).not.toHaveBeenCalled();
      expect(productUpdateMock).not.toHaveBeenCalled();
      expect(productUpdateManyMock).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });

    it("el stock nunca queda negativo aunque la cantidad pedida supere el stock actual", async () => {
      const ordenCantidadAlta = {
        ...ORDEN_CREADA_MOCK,
        estado: "PENDIENTE",
        items: [{ id: 1, ordenId: 100, productId: 1, nombreProducto: "Producto A", precioUnitario: "100.00", cantidad: 50 }],
      };
      ordenFindUniqueMock.mockResolvedValue(ordenCantidadAlta);
      // El descuento guardado no encuentra fila: el stock quedó por debajo de
      // lo pedido (ajuste manual o una orden anterior).
      productUpdateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
      ordenUpdateMock.mockResolvedValue({ ...ordenCantidadAlta, estado: "EN_PREPARACION" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(productUpdateManyMock).toHaveBeenNthCalledWith(2, {
        where: { id: 1, stock: { lt: 50 } },
        data: { stock: 0 },
      });
      expect(res.statusCode).toBe(200);
    });

    it("no descuenta si otra confirmación concurrente ya dejó la orden en EN_PREPARACION", async () => {
      // La lectura previa al `$transaction` solo sirve para el 404 temprano.
      // Si entre esa lectura y la transacción otro PATCH confirmó la misma
      // orden, la escritura guardada (`stockDescontado: false`) no matchea
      // ninguna fila y el stock no se toca.
      ordenFindUniqueMock
        .mockResolvedValueOnce({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" })
        .mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });
      ordenUpdateManyMock.mockResolvedValue({ count: 0 });
      productFindUniqueMock.mockResolvedValue({ ...PRODUCTO_DISPONIBLE, stock: 10 });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(productUpdateManyMock).not.toHaveBeenCalled();
      expect(productUpdateMock).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });

    it("decide la transición a EN_PREPARACION con una escritura guardada, no con la relectura", async () => {
      ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      // El árbitro de la transición es este updateMany guardado:
      // `stockDescontado: false` es la guarda ENTERA. Decidir con una lectura
      // bajo READ COMMITTED dejaba que dos PATCH concurrentes descontaran
      // dos veces. La condición sobre el estado de origen se sacó a propósito
      // al pasar a DOS estados que descuentan (ver ESTADOS_CON_STOCK_TOMADO):
      // con `estado: { not: "ENTREGADA" }`, EN_PREPARACION -> ENTREGADA
      // volvería a matchear y descontaría dos veces.
      // La misma escritura enciende `stockDescontado`: es lo que después le
      // permite a la cancelación saber que esta orden tiene stock tomado.
      expect(ordenUpdateManyMock).toHaveBeenCalledWith({
        where: { id: 100, stockDescontado: false },
        data: { estado: "EN_PREPARACION", stockDescontado: true },
      });
    });

    it("dos confirmaciones concurrentes que leyeron ambas PENDIENTE descuentan el stock UNA sola vez", async () => {
      // Simula la carrera de BK-A1: bajo READ COMMITTED las dos requests
      // releen PENDIENTE dentro de su transacción. La escritura guardada es
      // la que arbitra: la primera matchea la fila ({ count: 1 }), la segunda
      // ya la encuentra con `stockDescontado: true` ({ count: 0 }) y NO
      // descuenta.
      ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" });
      ordenUpdateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });

      const primera = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
      const segunda = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
      await actualizarEstado(primera.req, primera.res, primera.next);
      await actualizarEstado(segunda.req, segunda.res, segunda.next);

      expect(primera.next).not.toHaveBeenCalled();
      expect(segunda.next).not.toHaveBeenCalled();
      // La orden tiene 1 item: exactamente 1 descuento total entre los dos PATCH.
      expect(productUpdateManyMock).toHaveBeenCalledTimes(1);
      expect(primera.res.statusCode).toBe(200);
      expect(segunda.res.statusCode).toBe(200);
    });

    it("una confirmación con stock insuficiente responde con advertencias (una por producto afectado)", async () => {
      const ordenCantidadAlta = {
        ...ORDEN_CREADA_MOCK,
        estado: "PENDIENTE",
        items: [{ id: 1, ordenId: 100, productId: 1, nombreProducto: "Producto A", precioUnitario: "100.00", cantidad: 50 }],
      };
      ordenFindUniqueMock.mockResolvedValue(ordenCantidadAlta);
      // El descuento guardado no matchea (stock < 50) y el segundo updateMany
      // apoya la fila en 0.
      productUpdateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
      ordenUpdateMock.mockResolvedValue({ ...ordenCantidadAlta, estado: "EN_PREPARACION" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      // La sobreventa no bloquea la confirmación (el piso-en-cero se mantiene),
      // pero deja de ser silenciosa: un string por producto afectado.
      expect(res.body.advertencias).toHaveLength(1);
      expect(res.body.advertencias[0]).toContain("Producto A");
      expect(res.body.estado).toBe("EN_PREPARACION");
    });

    it("una confirmación sin faltantes de stock no incluye el campo advertencias", async () => {
      ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.body.advertencias).toBeUndefined();
    });

    it("una transición que no toma ni libera stock (PENDIENTE -> PENDIENTE) no pasa por ninguna escritura guardada", async () => {
      ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "PENDIENTE" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(ordenUpdateManyMock).not.toHaveBeenCalled();
      expect(productUpdateManyMock).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      expect(res.body.estado).toBe("PENDIENTE");
    });
  });

  it("permite ENTREGADA -> PENDIENTE (sin máquina de estados, cambios libres)", async () => {
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "ENTREGADA" });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "PENDIENTE" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body.estado).toBe("PENDIENTE");
  });

  it("permite CANCELADA -> EN_PREPARACION (cualquier transición es válida)", async () => {
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CANCELADA" });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("responde 400 si el estado no es uno de los 4 valores válidos", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "INVENTADO" } });
    await actualizarEstado(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(ordenUpdateMock).not.toHaveBeenCalled();
  });

  it("responde 404 si la orden no existe", async () => {
    ordenFindUniqueMock.mockResolvedValue(null);

    const { req, res, next } = buildReqRes({ params: { id: "999" }, body: { estado: "EN_PREPARACION" } });
    await actualizarEstado(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(404);
    expect(ordenUpdateMock).not.toHaveBeenCalled();
  });

  it("responde 404 si el id no es un número válido", async () => {
    const { req, res, next } = buildReqRes({ params: { id: "abc" }, body: { estado: "EN_PREPARACION" } });
    await actualizarEstado(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(404);
    expect(ordenFindUniqueMock).not.toHaveBeenCalled();
  });
});
