import { describe, expect, it, vi, beforeEach } from "vitest";

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
const eventoTraficoCreateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
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
    },
    eventoTrafico: {
      create: (...args) => eventoTraficoCreateMock(...args),
    },
    $transaction: (...args) => transactionMock(...args),
  },
}));

const { crear, listar, obtenerPorId, actualizarEstado, MAX_ITEMS_POR_ORDEN, MAX_CANTIDAD_POR_ITEM } =
  await import("./ordenes.controller.js");

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

// Shape devuelta por listar(): cliente completo + _count.items (NO items
// completos) — ver nota en ordenes.controller.js sobre por qué el listado
// no trae el detalle línea por línea.
const ORDEN_LISTADO_MOCK = {
  id: 100,
  clienteId: 10,
  estado: "PENDIENTE",
  notas: null,
  cliente: CLIENTE_EXISTENTE,
  _count: { items: 1 },
  createdAt: new Date(),
  updatedAt: new Date(),
};

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
  // NO estaba CONFIRMADA); los tests de carrera devuelven `{ count: 0 }`.
  ordenUpdateManyMock.mockResolvedValue({ count: 1 });
  eventoTraficoCreateMock.mockResolvedValue({});
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
  it("lista órdenes ordenadas por createdAt desc, con cliente y _count.items (NO items completos)", async () => {
    ordenFindManyMock.mockResolvedValue([ORDEN_LISTADO_MOCK]);
    ordenCountMock.mockResolvedValue(1);

    const { req, res, next } = buildReqRes();
    await listar(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(ordenFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: "desc" },
        include: { cliente: true, _count: { select: { items: true } } },
      }),
    );
    expect(res.body.data).toEqual([ORDEN_LISTADO_MOCK]);
    expect(res.body.data[0].items).toBeUndefined();
    expect(res.body.total).toBe(1);
  });

  it("filtra por estado exacto", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { estado: "CONFIRMADA" } });
    await listar(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(ordenFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ estado: "CONFIRMADA" }) }),
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

  it("filtra solo por desde (sin hasta)", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { desde: "2026-01-01" } });
    await listar(req, res, next);

    const where = ordenFindManyMock.mock.calls[0][0].where;
    expect(where.createdAt.gte).toBeInstanceOf(Date);
    expect(where.createdAt.lte).toBeUndefined();
  });

  it("ignora una fecha inválida sin romper la consulta", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const { req, res, next } = buildReqRes({ query: { desde: "no-es-fecha" } });
    await listar(req, res, next);

    expect(res.statusCode).toBe(200);
    const where = ordenFindManyMock.mock.calls[0][0].where ?? {};
    expect(where.createdAt).toBeUndefined();
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

describe("obtenerPorId()", () => {
  it("devuelve la orden con cliente e items", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({ params: { id: "100" } });
    await obtenerPorId(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(ordenFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        include: { cliente: true, items: true },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(ORDEN_CREADA_MOCK);
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
    ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CONFIRMADA" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(ordenUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 100 },
        data: { estado: "CONFIRMADA" },
        include: { cliente: true, items: true },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.estado).toBe("CONFIRMADA");
  });

  describe("descuento de stock al confirmar", () => {
    it("pasar de PENDIENTE a CONFIRMADA descuenta cantidad del stock de cada producto de la orden", async () => {
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
      ordenUpdateMock.mockResolvedValue({ ...ordenDosItems, estado: "CONFIRMADA" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
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

    it("pasar de CONFIRMADA a CONFIRMADA de nuevo no vuelve a descontar stock", async () => {
      ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CONFIRMADA" });
      // La escritura guardada no matchea ninguna fila: la orden ya estaba
      // CONFIRMADA, así que `estado != CONFIRMADA` no encuentra nada.
      ordenUpdateManyMock.mockResolvedValue({ count: 0 });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CONFIRMADA" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
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
      ordenUpdateMock.mockResolvedValue({ ...ordenCantidadAlta, estado: "CONFIRMADA" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(productUpdateManyMock).toHaveBeenNthCalledWith(2, {
        where: { id: 1, stock: { lt: 50 } },
        data: { stock: 0 },
      });
      expect(res.statusCode).toBe(200);
    });

    it("no descuenta si otra confirmación concurrente ya dejó la orden en CONFIRMADA", async () => {
      // La lectura previa al `$transaction` solo sirve para el 404 temprano.
      // Si entre esa lectura y la transacción otro PATCH confirmó la misma
      // orden, la escritura guardada (`estado != CONFIRMADA`) no matchea
      // ninguna fila y el stock no se toca.
      ordenFindUniqueMock
        .mockResolvedValueOnce({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" })
        .mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CONFIRMADA" });
      ordenUpdateManyMock.mockResolvedValue({ count: 0 });
      productFindUniqueMock.mockResolvedValue({ ...PRODUCTO_DISPONIBLE, stock: 10 });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CONFIRMADA" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(productUpdateManyMock).not.toHaveBeenCalled();
      expect(productUpdateMock).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });

    it("decide la transición a CONFIRMADA con una escritura guardada, no con la relectura", async () => {
      ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CONFIRMADA" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      // El árbitro de la transición es este updateMany guardado: solo matchea
      // si la orden todavía NO estaba CONFIRMADA. Decidir con una lectura
      // bajo READ COMMITTED dejaba que dos PATCH concurrentes descontaran
      // dos veces.
      // La misma escritura enciende `stockDescontado`: es lo que después le
      // permite a la cancelación saber que esta orden tiene stock tomado.
      expect(ordenUpdateManyMock).toHaveBeenCalledWith({
        where: { id: 100, estado: { not: "CONFIRMADA" } },
        data: { estado: "CONFIRMADA", stockDescontado: true },
      });
    });

    it("dos confirmaciones concurrentes que leyeron ambas PENDIENTE descuentan el stock UNA sola vez", async () => {
      // Simula la carrera de BK-A1: bajo READ COMMITTED las dos requests
      // releen PENDIENTE dentro de su transacción. La escritura guardada es
      // la que arbitra: la primera matchea la fila ({ count: 1 }), la segunda
      // ya la encuentra CONFIRMADA ({ count: 0 }) y NO descuenta.
      ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" });
      ordenUpdateManyMock.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CONFIRMADA" });

      const primera = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
      const segunda = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
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
      ordenUpdateMock.mockResolvedValue({ ...ordenCantidadAlta, estado: "CONFIRMADA" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      // La sobreventa no bloquea la confirmación (el piso-en-cero se mantiene),
      // pero deja de ser silenciosa: un string por producto afectado.
      expect(res.body.advertencias).toHaveLength(1);
      expect(res.body.advertencias[0]).toContain("Producto A");
      expect(res.body.estado).toBe("CONFIRMADA");
    });

    it("una confirmación sin faltantes de stock no incluye el campo advertencias", async () => {
      ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CONFIRMADA" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.body.advertencias).toBeUndefined();
    });

    it("una transición a un estado que no es CONFIRMADA no pasa por la escritura guardada ni descuenta", async () => {
      ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "PENDIENTE" });
      ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "EN_PREPARACION" });

      const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "EN_PREPARACION" } });
      await actualizarEstado(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(ordenUpdateManyMock).not.toHaveBeenCalled();
      expect(productUpdateManyMock).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
      expect(res.body.estado).toBe("EN_PREPARACION");
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

  it("permite CANCELADA -> CONFIRMADA (cualquier transición es válida)", async () => {
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CANCELADA" });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN_CREADA_MOCK, estado: "CONFIRMADA" });

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "CONFIRMADA" } });
    await actualizarEstado(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("responde 400 si el estado no es uno de los 5 valores válidos", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN_CREADA_MOCK);

    const { req, res, next } = buildReqRes({ params: { id: "100" }, body: { estado: "INVENTADO" } });
    await actualizarEstado(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(ordenUpdateMock).not.toHaveBeenCalled();
  });

  it("responde 404 si la orden no existe", async () => {
    ordenFindUniqueMock.mockResolvedValue(null);

    const { req, res, next } = buildReqRes({ params: { id: "999" }, body: { estado: "CONFIRMADA" } });
    await actualizarEstado(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(404);
    expect(ordenUpdateMock).not.toHaveBeenCalled();
  });

  it("responde 404 si el id no es un número válido", async () => {
    const { req, res, next } = buildReqRes({ params: { id: "abc" }, body: { estado: "CONFIRMADA" } });
    await actualizarEstado(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(404);
    expect(ordenFindUniqueMock).not.toHaveBeenCalled();
  });
});
