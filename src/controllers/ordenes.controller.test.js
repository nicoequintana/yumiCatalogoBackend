import { describe, expect, it, vi, beforeEach } from "vitest";

const clienteFindUniqueMock = vi.fn();
const clienteCreateMock = vi.fn();
const clienteUpdateMock = vi.fn();
const productFindManyMock = vi.fn();
const ordenCreateMock = vi.fn();
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
    },
    eventoTrafico: {
      create: (...args) => eventoTraficoCreateMock(...args),
    },
    $transaction: (...args) => transactionMock(...args),
  },
}));

const { crear } = await import("./ordenes.controller.js");

function buildReqRes(body) {
  const req = { body };
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
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
  disponibilidad: "DISPONIBLE",
};

const PRODUCTO_2_DISPONIBLE = {
  id: 2,
  nombre: "Producto B",
  precio: "50.00",
  visibleEnCatalogo: true,
  disponibilidad: "DISPONIBLE",
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

beforeEach(() => {
  clienteFindUniqueMock.mockReset();
  clienteCreateMock.mockReset();
  clienteUpdateMock.mockReset();
  productFindManyMock.mockReset();
  ordenCreateMock.mockReset();
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
      orden: {
        create: (...args) => ordenCreateMock(...args),
      },
    };
    return cb(tx);
  });

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
    const { req, res, next } = buildReqRes(bodyValido({ dni: undefined }));
    await crear(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("responde 400 si falta nombre", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ nombre: "" }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 si falta telefono", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ telefono: "" }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 si items es un array vacío", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ items: [] }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("responde 400 si items no es un array", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ items: "no-array" }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 si falta items", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ items: undefined }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });
});

describe("crear() — validación de DNI", () => {
  it("responde 400 con DNI inválido (muy corto) antes de tocar la DB", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ dni: "123" }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(clienteFindUniqueMock).not.toHaveBeenCalled();
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("responde 400 con DNI inválido (muy largo)", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ dni: "123456789012" }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 con DNI que no tiene ningún dígito", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ dni: "abcdefgh" }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });
});

describe("crear() — validación de items", () => {
  it("responde 400 si un item tiene productId no numérico", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ items: [{ productId: "abc", cantidad: 1 }] }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("responde 400 si un item tiene productId <= 0", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ items: [{ productId: 0, cantidad: 1 }] }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 si un item tiene cantidad <= 0", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ items: [{ productId: 1, cantidad: 0 }] }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("responde 400 si un item tiene cantidad negativa", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ items: [{ productId: 1, cantidad: -1 }] }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });

  it("responde 400 si un item tiene cantidad no entera", async () => {
    const { req, res, next } = buildReqRes(bodyValido({ items: [{ productId: 1, cantidad: 1.5 }] }));
    await crear(req, res, next);
    expect(next.mock.calls[0][0].status).toBe(400);
  });
});

describe("crear() — validación de productos contra la DB", () => {
  it("responde 400 si algún productId no existe, y no crea la orden (whole request rejected)", async () => {
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]); // solo vuelve 1 de los 2 pedidos
    const { req, res, next } = buildReqRes(
      bodyValido({
        items: [
          { productId: 1, cantidad: 1 },
          { productId: 999, cantidad: 1 },
        ],
      }),
    );

    await crear(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("responde 400 si un producto está AGOTADO, y no crea la orden", async () => {
    productFindManyMock.mockResolvedValue([{ ...PRODUCTO_DISPONIBLE, disponibilidad: "AGOTADO" }]);
    const { req, res, next } = buildReqRes(bodyValido({ items: [{ productId: 1, cantidad: 1 }] }));

    await crear(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("responde 400 si un producto tiene visibleEnCatalogo false, y no crea la orden", async () => {
    productFindManyMock.mockResolvedValue([{ ...PRODUCTO_DISPONIBLE, visibleEnCatalogo: false }]);
    const { req, res, next } = buildReqRes(bodyValido({ items: [{ productId: 1, cantidad: 1 }] }));

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

    const { req, res, next } = buildReqRes(bodyValido());
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

    const { req, res, next } = buildReqRes(
      bodyValido({ nombre: "Juan Perez Actualizado", telefono: "1199999999" }),
    );
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

    const { req, res, next } = buildReqRes(bodyValido({ dni: "12.345.678" }));
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

    const { req, res, next } = buildReqRes(bodyValido({ items: [{ productId: 1, cantidad: 3 }] }));
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

    const { req, res, next } = buildReqRes(
      bodyValido({
        items: [
          { productId: 1, cantidad: 2 },
          { productId: 2, cantidad: 5 },
        ],
      }),
    );
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

    const { req, res, next } = buildReqRes(bodyValido());
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

    const { req, res, next } = buildReqRes(bodyValido());
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

    const { req, res, next } = buildReqRes(bodyValido());
    await crear(req, res, next);

    expect(res.statusCode).toBe(201);
    expect(res.body.cliente).toEqual(CLIENTE_EXISTENTE);
    expect(res.body.items).toEqual(ORDEN_CREADA_MOCK.items);
  });
});
