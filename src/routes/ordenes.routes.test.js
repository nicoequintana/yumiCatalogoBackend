import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

// `POST /api/ordenes` está detrás de un limitador de 10 solicitudes/10min con
// store en memoria por proceso (ver rateLimit.middleware.js), y ese store es
// un singleton de módulo: vive mientras dure este archivo, no se resetea test
// a test. Este archivo ya hace más de 10 POST reales a lo largo de su propia
// suite, así que sin este mock los últimos tests reciben 429 en vez del
// status que en realidad están probando. El comportamiento del limitador
// tiene su propia cobertura dedicada en rateLimit.middleware.test.js — acá
// solo se neutraliza para no ensuciar tests que no son sobre rate limiting.
vi.mock("../middlewares/rateLimit.middleware.js", () => ({
  crearLimitadorDeVelocidad: () => (_req, _res, next) => next(),
}));

// `authClienteOpcional` real vive en la Parte 1 y depende de la cookie
// `sesion_cliente` + `jwtCliente.js`. Esta suite no la ejercita — eso lo
// prueba `authCliente.middleware.test.js`. Acá se mockea a un middleware
// controlable: si el request trae el header de prueba `x-test-cuenta`, setea
// `req.cuentaCliente` con ese valor (simula sesión); si no, lo deja `null`
// (simula anónimo). El header nunca existe fuera de tests.
vi.mock("../middlewares/authCliente.middleware.js", () => ({
  authClienteOpcional: (req, _res, next) => {
    const header = req.get("x-test-cuenta");
    req.cuentaCliente = header ? JSON.parse(header) : null;
    next();
  },
}));

// El flag de la decisión 7 (publicación en dos etapas). Mutable por test:
// cada `it` que necesite `true` lo setea y el `beforeEach` lo vuelve a
// `false`, que es el default real cuando la variable de entorno no existe.
let flagChequeoCuenta = false;
vi.mock("../lib/env.js", () => ({
  checkoutRequiereCuenta: () => flagChequeoCuenta,
}));

const notificarOrdenCreadaMock = vi.fn();
const notificarCambioEstadoMock = vi.fn();

vi.mock("../services/notificacionesOrden.service.js", () => ({
  notificarOrdenCreada: (...args) => notificarOrdenCreadaMock(...args),
  notificarCambioEstado: (...args) => notificarCambioEstadoMock(...args),
}));

const cuentaClienteFindUniqueMock = vi.fn();
const cuentaClienteUpdateMock = vi.fn();
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
const promocionItemFindManyMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: (...args) => auditCreateMock(...args) },
    // El perfil de la cuenta se lee FUERA de la transacción —igual que
    // `validarYSnapshotearProductos`—, así que el mock vive en el `prisma`
    // de arriba y no en el cliente que recibe el `$transaction`.
    cuentaCliente: {
      findUnique: (...args) => cuentaClienteFindUniqueMock(...args),
      update: (...args) => cuentaClienteUpdateMock(...args),
    },
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
    promocionItem: {
      findMany: (...args) => promocionItemFindManyMock(...args),
    },
    $transaction: async (cb) =>
      cb({
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
      }),
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

const PRODUCTO_DISPONIBLE = {
  id: 1,
  nombre: "Producto A",
  precio: "100.00",
  visibleEnCatalogo: true,
  stock: 10,
};

const CLIENTE = { id: 10, dni: "12345678", nombre: "Juan Perez", telefono: "1122334455", email: "juan@gmail.com" };

/**
 * El perfil de `CuentaCliente` que devuelve la consulta del checkout con
 * sesión. Los tres campos DIFIEREN a propósito de los del body de invitado
 * (`CLIENTE`): con valores iguales, un test que solo mira el 201 no
 * distinguiría "salió de la cuenta" de "salió del body", que es exactamente
 * la diferencia que defienden las amenazas 5 y 7 de la spec.
 */
const PERFIL_CUENTA = { nombre: "Titular De Cuenta", telefono: "1199887766", dni: "87654321" };

const ORDEN = {
  id: 100,
  clienteId: 10,
  estado: "PENDIENTE",
  notas: null,
  cliente: CLIENTE,
  items: [{ id: 1, ordenId: 100, productId: 1, nombreProducto: "Producto A", precioUnitario: "100.00", cantidad: 1 }],
};

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  flagChequeoCuenta = false;
  auditCreateMock.mockReset();
  auditCreateMock.mockResolvedValue({ id: 1 });
  cuentaClienteFindUniqueMock.mockReset();
  cuentaClienteUpdateMock.mockReset();
  clienteFindUniqueMock.mockReset();
  clienteCreateMock.mockReset();
  clienteUpdateMock.mockReset();
  productFindManyMock.mockReset();
  productFindUniqueMock.mockReset();
  productUpdateMock.mockReset();
  productUpdateManyMock.mockReset();
  // Por defecto el descuento guardado encuentra la fila y la actualiza.
  productUpdateManyMock.mockResolvedValue({ count: 1 });
  ordenCreateMock.mockReset();
  ordenFindManyMock.mockReset();
  ordenFindUniqueMock.mockReset();
  ordenUpdateMock.mockReset();
  ordenUpdateManyMock.mockReset();
  // Por defecto la escritura guardada de transición matchea la fila (la
  // orden NO tenía `stockDescontado: true`).
  ordenUpdateManyMock.mockResolvedValue({ count: 1 });
  ordenCountMock.mockReset();
  ordenGroupByMock.mockReset();
  ordenGroupByMock.mockResolvedValue([]);
  eventoTraficoCreateMock.mockReset();
  eventoTraficoCreateMock.mockResolvedValue({});
  promocionItemFindManyMock.mockReset();
  // Por defecto NO hay ninguna promoción vigente, que es el caso normal.
  promocionItemFindManyMock.mockResolvedValue([]);
  notificarOrdenCreadaMock.mockReset();
  notificarOrdenCreadaMock.mockResolvedValue(undefined);
  notificarCambioEstadoMock.mockReset();
  notificarCambioEstadoMock.mockResolvedValue({ intentada: true, enviada: true });
});

describe("POST /api/ordenes", () => {
  it("no requiere autenticación (checkout de invitado)", async () => {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN);

    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        email: "juan@gmail.com",
        items: [{ productId: 1, cantidad: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.cliente).toBeDefined();
    expect(res.body.items).toBeDefined();
  });

  // Regresión de la fuga de costo por el checkout público. Este endpoint no
  // tiene `requireAuth` —solo rate limit por IP— y devolvía la fila cruda de
  // Prisma, así que cada 201 le entregaba al comprador anónimo el
  // `costoUnitario` de cada línea, o sea el margen del negocio.
  it("NO devuelve costoUnitario en los items del 201", async () => {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([{ ...PRODUCTO_DISPONIBLE, costo: "40" }]);
    ordenCreateMock.mockResolvedValue({
      ...ORDEN,
      items: [{ ...ORDEN.items[0], costoUnitario: "40" }],
    });

    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        email: "juan@gmail.com",
        items: [{ productId: 1, cantidad: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.items[0]).not.toHaveProperty("costoUnitario");
    expect(JSON.stringify(res.body)).not.toContain("costoUnitario");
    // El snapshot SÍ se sigue persistiendo: sin él, el margen de una venta
    // pasada se calcularía contra el costo de hoy.
    expect(ordenCreateMock.mock.calls[0][0].data.items.create[0].costoUnitario).toBe("40");
  });

  it("responde 400 si falta el body requerido", async () => {
    const res = await request(buildApp()).post("/api/ordenes").send({});
    expect(res.status).toBe(400);
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("responde 400 si el producto no existe", async () => {
    productFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        email: "juan@gmail.com",
        items: [{ productId: 999, cantidad: 1 }],
      });

    expect(res.status).toBe(400);
  });
});

describe("POST /api/ordenes — corte por flag (decisión 7)", () => {
  const BODY_INVITADO = {
    dni: "12345678",
    nombre: "Juan Perez",
    telefono: "1122334455",
    email: "juan@gmail.com",
    items: [{ productId: 1, cantidad: 1 }],
  };
  const CUENTA_HEADER = JSON.stringify({ id: 9, email: "cuenta@gmail.com" });

  function prepararAltaExitosa() {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN);
    // Perfil DISTINTO del body de invitado en los tres campos: así un 201 con
    // sesión no puede pasar por casualidad mirando solo el status. Las dos
    // puertas del perfil (lectura y actualización) devuelven lo mismo.
    cuentaClienteFindUniqueMock.mockResolvedValue(PERFIL_CUENTA);
    cuentaClienteUpdateMock.mockResolvedValue(PERFIL_CUENTA);
  }

  it("flag false, sin sesión: 201 como el checkout de invitado de siempre", async () => {
    prepararAltaExitosa();
    const res = await request(buildApp()).post("/api/ordenes").send(BODY_INVITADO);
    expect(res.status).toBe(201);
  });

  it("flag false, sin sesión: el Cliente se escribe con los datos DEL BODY", async () => {
    prepararAltaExitosa();
    const res = await request(buildApp()).post("/api/ordenes").send(BODY_INVITADO);

    expect(res.status).toBe(201);
    expect(clienteCreateMock).toHaveBeenCalledWith({
      data: {
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        email: "juan@gmail.com",
      },
    });
  });

  it("flag false, CON sesión: 201, pero el Cliente sale de la CUENTA, no del body", async () => {
    prepararAltaExitosa();
    // Sin contacto en el body: el checkout lo resuelve entero desde el perfil.
    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send({ items: BODY_INVITADO.items });

    expect(res.status).toBe(201);
    // Ninguno de los cuatro valores del body de invitado llegó a la base: este
    // test deja de ser un duplicado del de invitado justo acá.
    expect(clienteCreateMock).toHaveBeenCalledWith({
      data: {
        dni: PERFIL_CUENTA.dni,
        nombre: PERFIL_CUENTA.nombre,
        telefono: PERFIL_CUENTA.telefono,
        email: "cuenta@gmail.com",
      },
    });
  });

  it("flag true, sin sesión: 401 SESION_INVALIDA, y NO llega a crear nada", async () => {
    flagChequeoCuenta = true;
    const res = await request(buildApp()).post("/api/ordenes").send(BODY_INVITADO);
    expect(res.status).toBe(401);
    expect(res.body.codigo).toBe("SESION_INVALIDA");
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("flag true, CON sesión: 201", async () => {
    flagChequeoCuenta = true;
    prepararAltaExitosa();
    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send(BODY_INVITADO);
    expect(res.status).toBe(201);
  });

  it("el corte por flag va ANTES del limitador: un 401 no consume cuota de pedidos", async () => {
    // `crearLimitadorDeVelocidad` está mockeado a no-op en este archivo, así
    // que este test verifica el ORDEN por otro lado: si el corte fuera
    // posterior al limitador, la llamada al limitador (el mock) igual
    // ocurriría antes del 401 — lo que este test afirma es que ninguna
    // escritura de negocio (`ordenCreateMock`) corre, que es la señal
    // observable de que el handler de negocio nunca se alcanzó.
    flagChequeoCuenta = true;
    const res = await request(buildApp()).post("/api/ordenes").send(BODY_INVITADO);
    expect(res.status).toBe(401);
    expect(clienteFindUniqueMock).not.toHaveBeenCalled();
    expect(productFindManyMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ordenes — con sesión (decisión 8)", () => {
  const CUENTA = { id: 9, email: "cuenta@gmail.com" };
  const CUENTA_HEADER = JSON.stringify(CUENTA);

  // Body con sesión: los tres campos de perfil son legítimos (se escriben en
  // la PROPIA cuenta), pero el `email` y todo lo demás tiene que rebotar
  // contra la lista blanca.
  const BODY_CON_PERFIL = {
    dni: "12345678",
    nombre: "Juan Perez",
    telefono: "1122334455",
    email: "el-email-de-otro@evil.com",
    emailVerificado: true,
    tokenVersion: 99,
    items: [{ productId: 1, cantidad: 1 }],
  };

  /** Lo que queda en la cuenta después de escribirle los tres campos del body. */
  const PERFIL_ESCRITO = { nombre: "Juan Perez", telefono: "1122334455", dni: "12345678" };

  const CLIENTE_DE_LA_CUENTA = {
    id: 11,
    dni: PERFIL_ESCRITO.dni,
    nombre: PERFIL_ESCRITO.nombre,
    telefono: PERFIL_ESCRITO.telefono,
    email: CUENTA.email,
  };

  const ORDEN_CON_CUENTA = {
    id: 200,
    clienteId: 11,
    cuentaClienteId: 9,
    estado: "PENDIENTE",
    notas: null,
    cliente: CLIENTE_DE_LA_CUENTA,
    items: [
      { id: 1, ordenId: 200, productId: 1, nombreProducto: "Producto A", precioUnitario: "100", cantidad: 1 },
    ],
  };

  beforeEach(() => {
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE_DE_LA_CUENTA);
    ordenCreateMock.mockResolvedValue(ORDEN_CON_CUENTA);
    cuentaClienteFindUniqueMock.mockResolvedValue(PERFIL_CUENTA);
    cuentaClienteUpdateMock.mockResolvedValue(PERFIL_ESCRITO);
  });

  it("el email SIEMPRE sale de la cuenta, nunca del body", async () => {
    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send(BODY_CON_PERFIL);

    expect(res.status).toBe(201);
    expect(clienteCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: CUENTA.email }),
    });
    // Y tampoco se coló como escritura del perfil.
    expect(cuentaClienteUpdateMock.mock.calls[0][0].data).not.toHaveProperty("email");
  });

  it("nombre/telefono/dni del body SE ESCRIBEN en la cuenta, y nada más (lista blanca)", async () => {
    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send(BODY_CON_PERFIL);

    expect(res.status).toBe(201);
    expect(cuentaClienteUpdateMock).toHaveBeenCalledWith({
      where: { id: CUENTA.id },
      data: { nombre: "Juan Perez", telefono: "1122334455", dni: "12345678" },
      select: { nombre: true, telefono: true, dni: true },
    });
    // `emailVerificado` y `tokenVersion` viajaban en el body (amenaza 8).
    const escrito = cuentaClienteUpdateMock.mock.calls[0][0].data;
    expect(escrito).not.toHaveProperty("emailVerificado");
    expect(escrito).not.toHaveProperty("tokenVersion");
  });

  it("el contacto de la orden sale de la cuenta YA ACTUALIZADA", async () => {
    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send(BODY_CON_PERFIL);

    expect(res.status).toBe(201);
    expect(clienteCreateMock).toHaveBeenCalledWith({
      data: {
        dni: PERFIL_ESCRITO.dni,
        nombre: PERFIL_ESCRITO.nombre,
        telefono: PERFIL_ESCRITO.telefono,
        email: CUENTA.email,
      },
    });
  });

  it("el DNI del body se normaliza antes de escribirse en la cuenta", async () => {
    await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send({ dni: "12.345.678", items: [{ productId: 1, cantidad: 1 }] });

    expect(cuentaClienteUpdateMock).toHaveBeenCalledWith({
      where: { id: CUENTA.id },
      data: { dni: "12345678" },
      select: { nombre: true, telefono: true, dni: true },
    });
  });

  it("un DNI inválido en el body es 400 y no escribe NADA (ni perfil ni orden)", async () => {
    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send({ dni: "123", items: [{ productId: 1, cantidad: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/7 u 8 dígitos/i);
    expect(cuentaClienteUpdateMock).not.toHaveBeenCalled();
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("un nombre vacío en el body es 400, igual que en PUT /cuenta", async () => {
    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send({ nombre: "   ", items: [{ productId: 1, cantidad: 1 }] });

    expect(res.status).toBe(400);
    expect(cuentaClienteUpdateMock).not.toHaveBeenCalled();
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("sin contacto en el body, lee el perfil y NO lo escribe", async () => {
    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send({ items: [{ productId: 1, cantidad: 1 }] });

    expect(res.status).toBe(201);
    expect(cuentaClienteUpdateMock).not.toHaveBeenCalled();
    expect(cuentaClienteFindUniqueMock).toHaveBeenCalledWith({
      where: { id: CUENTA.id },
      select: { nombre: true, telefono: true, dni: true },
    });
    expect(clienteCreateMock).toHaveBeenCalledWith({
      data: {
        dni: PERFIL_CUENTA.dni,
        nombre: PERFIL_CUENTA.nombre,
        telefono: PERFIL_CUENTA.telefono,
        email: CUENTA.email,
      },
    });
  });

  it("si el perfil está incompleto y el body no aporta nada, 400 que manda a completarlo", async () => {
    cuentaClienteFindUniqueMock.mockResolvedValue({ nombre: null, telefono: null, dni: null });

    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send({ items: [{ productId: 1, cantidad: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/perfil/i);
    expect(clienteCreateMock).not.toHaveBeenCalled();
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  // El agujero funcional de la primera versión: una cuenta nacida de Google no
  // tiene DNI, y el checkout ignoraba el que la persona tipeaba — no podía
  // comprar NUNCA. Ahora ese DNI se escribe en la cuenta y la compra sale.
  it("una cuenta SIN dni compra igual si el body trae uno válido", async () => {
    cuentaClienteUpdateMock.mockResolvedValue({ ...PERFIL_CUENTA, dni: "87654321" });

    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send({ dni: "87654321", items: [{ productId: 1, cantidad: 1 }] });

    expect(res.status).toBe(201);
    expect(cuentaClienteUpdateMock).toHaveBeenCalledWith({
      where: { id: CUENTA.id },
      data: { dni: "87654321" },
      select: { nombre: true, telefono: true, dni: true },
    });
    expect(clienteCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ dni: "87654321", email: CUENTA.email }),
    });
  });

  it("una cuenta SIN dni y sin dni en el body es 400, no un 500 del $transaction", async () => {
    cuentaClienteFindUniqueMock.mockResolvedValue({ ...PERFIL_CUENTA, dni: null });

    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send({ items: [{ productId: 1, cantidad: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/perfil/i);
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("upsertClienteConReintento sigue siendo el único escritor de Cliente", async () => {
    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send(BODY_CON_PERFIL);

    expect(res.status).toBe(201);
    expect(clienteCreateMock).toHaveBeenCalledTimes(1);
    expect(clienteUpdateMock).not.toHaveBeenCalled();
  });

  it("la orden se crea con cuentaClienteId", async () => {
    await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send(BODY_CON_PERFIL);

    expect(ordenCreateMock.mock.calls[0][0].data.cuentaClienteId).toBe(CUENTA.id);
  });

  it("sin sesión, cuentaClienteId es null y el perfil ni se consulta", async () => {
    ordenCreateMock.mockResolvedValue(ORDEN);

    await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        email: "juan@gmail.com",
        items: [{ productId: 1, cantidad: 1 }],
      });

    expect(ordenCreateMock.mock.calls[0][0].data.cuentaClienteId).toBeNull();
    // Sin sesión no hay perfil que leer NI que escribir: el checkout de
    // invitado no toca `CuentaCliente` por ningún lado.
    expect(cuentaClienteFindUniqueMock).not.toHaveBeenCalled();
    expect(cuentaClienteUpdateMock).not.toHaveBeenCalled();
  });

  it("la respuesta con sesión pasa por mapOrdenCuenta: sin cliente ni ids de identidad", async () => {
    const res = await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send(BODY_CON_PERFIL);

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("cliente");
    expect(res.body).not.toHaveProperty("cuentaCliente");
    expect(res.body).not.toHaveProperty("cuentaClienteId");
    expect(res.body).not.toHaveProperty("clienteId");
    // Lo que SÍ tiene que seguir viajando: la orden y sus líneas.
    expect(res.body.id).toBe(200);
    expect(res.body.items).toHaveLength(1);
  });

  it("la respuesta SIN sesión sigue llevando cliente (mapOrden, el eco de siempre)", async () => {
    ordenCreateMock.mockResolvedValue(ORDEN);

    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        email: "juan@gmail.com",
        items: [{ productId: 1, cantidad: 1 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.cliente).toBeDefined();
  });

  // El comprobante al comprador lo manda `notificacionesOrden.service.js`
  // leyendo la fila CRUDA. Si el `include` del create con sesión se quedara
  // sin contacto, el 201 seguiría saliendo y el mail desaparecería sin ningún
  // error. Se afirma el CONTACTO, no el camino: la Task 8 lo mueve a
  // `contactoDeOrden` y este test tiene que sobrevivir a ese cambio.
  it("la fila que recibe notificarOrdenCreada trae con qué escribirle al comprador", async () => {
    await request(buildApp())
      .post("/api/ordenes")
      .set("x-test-cuenta", CUENTA_HEADER)
      .send(BODY_CON_PERFIL);

    const fila = notificarOrdenCreadaMock.mock.calls[0][0];
    expect(fila.cuentaCliente?.email ?? fila.cliente?.email).toBe(CUENTA.email);
  });
});

describe("GET /api/ordenes", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/ordenes");
    expect(res.status).toBe(401);
  });

  it("responde 200 con token y devuelve el listado paginado", async () => {
    ordenFindManyMock.mockResolvedValue([ORDEN]);
    ordenCountMock.mockResolvedValue(1);

    const res = await request(buildApp()).get("/api/ordenes").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
  });

  it("escapa los comodines de LIKE del filtro por nombre de cliente", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    // `%25` es un `%` codificado en la query string. Sin escape, el `%` viajaría
    // como comodín de LIKE y el filtro devolvería clientes que no se pidieron.
    await request(buildApp()).get("/api/ordenes?nombre=Pe%25rez").set("Authorization", authHeader);

    const { where } = ordenFindManyMock.mock.calls[0][0];
    expect(where.cliente.nombre).toEqual({ contains: "Pe[%]rez" });
  });
});

describe("GET /api/ordenes/:id", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/ordenes/100");
    expect(res.status).toBe(401);
  });

  it("responde 200 con token y devuelve la orden", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN);

    const res = await request(buildApp()).get("/api/ordenes/100").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(100);
  });

  it("responde 404 si la orden no existe", async () => {
    ordenFindUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/ordenes/999").set("Authorization", authHeader);

    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/ordenes/:id/estado", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).patch("/api/ordenes/100/estado").send({ estado: "EN_PREPARACION" });
    expect(res.status).toBe(401);
  });

  it("responde 200 con token y actualiza el estado", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN);
    productUpdateManyMock.mockResolvedValue({ count: 1 });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN, estado: "EN_PREPARACION" });

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "EN_PREPARACION" });

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe("EN_PREPARACION");
    // El descuento lo resuelve la base sobre el valor vigente de la fila.
    expect(productUpdateManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, stock: { gte: 1 } },
        data: { stock: { decrement: 1 } },
      }),
    );
  });

  it("responde 400 si el estado no es válido", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN);

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "INVENTADO" });

    expect(res.status).toBe(400);
  });

  it("permite ENTREGADA -> PENDIENTE sin restricciones de máquina de estados", async () => {
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN, estado: "ENTREGADA" });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN, estado: "PENDIENTE" });

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "PENDIENTE" });

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe("PENDIENTE");
  });
});

describe("auditoría de órdenes", () => {
  it("registra en AuditLog el cambio de estado, con el estado anterior y el nuevo", async () => {
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN, estado: "PENDIENTE" });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN, estado: "EN_PREPARACION" });
    productFindUniqueMock.mockResolvedValue(PRODUCTO_DISPONIBLE);
    productUpdateMock.mockResolvedValue({});

    await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "EN_PREPARACION" });

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accion: "ACTUALIZAR_ESTADO",
        entidad: "Orden",
        entidadId: 100,
        usuarioEmail: "admin@yima.test",
        detalle: JSON.stringify({
          estadoAnterior: "PENDIENTE",
          estadoNuevo: "EN_PREPARACION",
          stockDescontado: true,
        }),
      }),
    });
  });

  it("una confirmación con stock insuficiente devuelve advertencias y registra el faltante en AuditLog", async () => {
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN, estado: "PENDIENTE" });
    // El descuento guardado no matchea (stock quedó por debajo de lo pedido);
    // el segundo updateMany apoya la fila en 0.
    productUpdateManyMock.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN, estado: "EN_PREPARACION" });

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "EN_PREPARACION" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(200);
    expect(res.body.advertencias).toHaveLength(1);
    expect(res.body.advertencias[0]).toContain("Producto A");

    // El AuditLog recibe el detalle estructurado del faltante, además del
    // cambio de estado.
    const detalle = JSON.parse(auditCreateMock.mock.calls[0][0].data.detalle);
    expect(detalle.estadoNuevo).toBe("EN_PREPARACION");
    expect(detalle.stockDescontado).toBe(true);
    expect(detalle.stockInsuficiente).toEqual([
      { productId: 1, nombreProducto: "Producto A", cantidadPedida: 1 },
    ]);
  });

  it("NO registra nada en AuditLog al crear una orden (checkout público, no es acción de admin)", async () => {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN);
    eventoTraficoCreateMock.mockResolvedValue({});

    await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        email: "juan@gmail.com",
        items: [{ productId: 1, cantidad: 1 }],
      });

    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("emite el evento ORDEN_CREADA al crear una orden", async () => {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN);
    eventoTraficoCreateMock.mockResolvedValue({});

    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        email: "juan@gmail.com",
        items: [{ productId: 1, cantidad: 1 }],
      });
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(201);
    expect(eventoTraficoCreateMock).toHaveBeenCalledTimes(1);
    expect(eventoTraficoCreateMock.mock.calls[0][0].data).toMatchObject({
      tipo: "ORDEN_CREADA",
    });
  });

  it("responde 201 igual si el insert del evento falla (best-effort)", async () => {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN);
    eventoTraficoCreateMock.mockRejectedValue(new Error("DB caída"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "12345678",
        nombre: "Juan Perez",
        telefono: "1122334455",
        email: "juan@gmail.com",
        items: [{ productId: 1, cantidad: 1 }],
      });
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toBe(201);
    spy.mockRestore();
  });

  it("NO registra nada en AuditLog al listar órdenes (las lecturas no se auditan)", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/ordenes").set("Authorization", authHeader);

    expect(auditCreateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ordenes — email obligatorio y notificaciones", () => {
  const BODY_VALIDO = {
    dni: "12345678",
    nombre: "Juan Perez",
    telefono: "1122334455",
    email: "juan@gmail.com",
    items: [{ productId: 1, cantidad: 1 }],
  };

  function prepararAltaExitosa() {
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue(CLIENTE);
    productFindManyMock.mockResolvedValue([PRODUCTO_DISPONIBLE]);
    ordenCreateMock.mockResolvedValue(ORDEN);
  }

  it("rechaza con 400 si falta el email", async () => {
    const { email: _email, ...sinEmail } = BODY_VALIDO;

    const res = await request(buildApp()).post("/api/ordenes").send(sinEmail);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El email es obligatorio.");
  });

  it("rechaza con 400 si el email tiene formato inválido", async () => {
    const res = await request(buildApp())
      .post("/api/ordenes")
      .send({ ...BODY_VALIDO, email: "juan-arroba-gmail" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El email no tiene un formato válido.");
  });

  it("no toca la base cuando el email es inválido", async () => {
    await request(buildApp()).post("/api/ordenes").send({ ...BODY_VALIDO, email: "roto" });

    expect(productFindManyMock).not.toHaveBeenCalled();
    expect(ordenCreateMock).not.toHaveBeenCalled();
  });

  it("dispara las notificaciones con la orden creada", async () => {
    prepararAltaExitosa();

    const res = await request(buildApp()).post("/api/ordenes").send(BODY_VALIDO);

    expect(res.status).toBe(201);
    expect(notificarOrdenCreadaMock).toHaveBeenCalledWith(ORDEN);
  });

  it("responde 201 aunque el envío de correo falle", async () => {
    prepararAltaExitosa();
    notificarOrdenCreadaMock.mockRejectedValue(new Error("SMTP caído"));

    const res = await request(buildApp()).post("/api/ordenes").send(BODY_VALIDO);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(100);
  });
});

describe("PATCH /api/ordenes/:id/estado — notificación al cliente", () => {
  function prepararCambio() {
    const confirmada = { ...ORDEN, estado: "EN_PREPARACION" };
    ordenFindUniqueMock.mockResolvedValue(ORDEN);
    ordenUpdateMock.mockResolvedValue(confirmada);
    return confirmada;
  }

  it("no notifica cuando no viene el campo", async () => {
    prepararCambio();

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "EN_PREPARACION" });

    expect(res.status).toBe(200);
    expect(notificarCambioEstadoMock).not.toHaveBeenCalled();
    expect(res.body.notificacion).toBeUndefined();
  });

  it("no notifica cuando notificarCliente es false", async () => {
    prepararCambio();

    await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "EN_PREPARACION", notificarCliente: false });

    expect(notificarCambioEstadoMock).not.toHaveBeenCalled();
  });

  it("notifica con la orden YA actualizada cuando se pide", async () => {
    const confirmada = prepararCambio();

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "EN_PREPARACION", notificarCliente: true });

    expect(res.status).toBe(200);
    expect(notificarCambioEstadoMock).toHaveBeenCalledWith(confirmada);
    expect(res.body.notificacion).toEqual({ intentada: true, enviada: true });
  });

  it("guarda el estado igual cuando el envío falla", async () => {
    prepararCambio();
    notificarCambioEstadoMock.mockResolvedValue({
      intentada: true,
      enviada: false,
      error: "Invalid login",
    });

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "EN_PREPARACION", notificarCliente: true });

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe("EN_PREPARACION");
    expect(res.body.notificacion.enviada).toBe(false);
    expect(res.body.notificacion.error).toBe("Invalid login");
  });

  it("informa cuando el cliente no tiene email, sin fallar el cambio", async () => {
    prepararCambio();
    notificarCambioEstadoMock.mockResolvedValue({
      intentada: false,
      enviada: false,
      error: "El cliente no tiene email registrado.",
    });

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "ENTREGADA", notificarCliente: true });

    expect(res.status).toBe(200);
    expect(res.body.notificacion.intentada).toBe(false);
  });

  it("ignora un notificarCliente que no sea booleano true", async () => {
    prepararCambio();

    await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "EN_PREPARACION", notificarCliente: "si" });

    expect(notificarCambioEstadoMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/ordenes/resumen", () => {
  it("requiere autenticación", async () => {
    const res = await request(buildApp()).get("/api/ordenes/resumen");
    expect(res.status).toBe(401);
  });

  it("devuelve el conteo por estado con los cuatro estados", async () => {
    ordenGroupByMock.mockResolvedValue([{ estado: "PENDIENTE", _count: { _all: 2 } }]);

    const res = await request(buildApp())
      .get("/api/ordenes/resumen")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      PENDIENTE: 2,
      EN_PREPARACION: 0,
      ENTREGADA: 0,
      CANCELADA: 0,
    });
  });

  // El pisotón de siempre: sin declararla ANTES de `/:id`, Express matchea
  // "resumen" como un id de orden, `obtenerPorId` lo lee como `NaN` y esto
  // responde el 404 de una orden inexistente en vez del conteo. Mismo motivo
  // que `/estados` y `/productos-solicitados`.
  it("no la matchea GET /ordenes/:id", async () => {
    ordenFindUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp())
      .get("/api/ordenes/resumen")
      .set("Authorization", authHeader);

    expect(res.status).not.toBe(404);
    expect(ordenFindUniqueMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/ordenes/estados", () => {
  it("devuelve los cuatro estados con etiqueta y bandera terminal", async () => {
    const res = await request(buildApp())
      .get("/api/ordenes/estados")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.estados).toEqual([
      { valor: "PENDIENTE", etiqueta: "Pendiente", terminal: false },
      { valor: "EN_PREPARACION", etiqueta: "En preparación", terminal: false },
      { valor: "ENTREGADA", etiqueta: "Entregada", terminal: true },
      { valor: "CANCELADA", etiqueta: "Cancelada", terminal: true },
    ]);
  });

  it("requiere autenticación", async () => {
    const res = await request(buildApp()).get("/api/ordenes/estados");
    expect(res.status).toBe(401);
  });

  // El pisotón de siempre: sin declararla ANTES de `/:id`, Express matchea
  // "estados" como un id de orden y esto respondería el 404 de una orden
  // inexistente en vez de la lista.
  it("no se confunde con GET /ordenes/:id", async () => {
    const res = await request(buildApp())
      .get("/api/ordenes/estados")
      .set("Authorization", authHeader);

    expect(res.body).not.toHaveProperty("error");
  });
});

describe("estadoEtiqueta en TODOS los caminos que devuelven una orden", () => {
  // El smoke test contra la API real atrapó lo que la suite no vio: `listar`,
  // `obtenerPorId` y `actualizarEstado` devolvían la fila cruda de Prisma sin
  // pasar por `mapOrden`, así que `estadoEtiqueta` salía undefined y el panel
  // caía al respaldo (la clave cruda). Estos tests fijan que los tres caminos
  // pasen por el mapper.
  it("GET /ordenes (listado) emite estadoEtiqueta, total y resumen en cada fila", async () => {
    // El fixture trae los items con la forma que pide LISTADO_ORDEN_INCLUDE:
    // un `items: undefined` haria pasar el test sin ejercitar los derivados,
    // que son justo la parte del listado capaz de publicar un monto inventado.
    ordenFindManyMock.mockResolvedValue([
      { ...ORDEN, items: [{ nombreProducto: "Producto A", precioUnitario: "100", cantidad: 2 }] },
    ]);
    ordenCountMock.mockResolvedValue(1);

    const res = await request(buildApp()).get("/api/ordenes").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data[0].estadoEtiqueta).toBe("Pendiente");
    expect(res.body.data[0].total).toBe("200");
    expect(res.body.data[0].cantidadItems).toBe(1);
    expect(res.body.data[0].resumen).toEqual([{ nombreProducto: "Producto A", cantidad: 2 }]);
  });

  it("GET /ordenes/:id emite estadoEtiqueta", async () => {
    ordenFindUniqueMock.mockResolvedValue(ORDEN);

    const res = await request(buildApp()).get("/api/ordenes/100").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.estadoEtiqueta).toBe("Pendiente");
  });

  it("PATCH /ordenes/:id/estado responde con la etiqueta del estado NUEVO", async () => {
    ordenFindUniqueMock.mockResolvedValue({ ...ORDEN, items: [] });
    ordenUpdateMock.mockResolvedValue({ ...ORDEN, estado: "EN_PREPARACION", items: [] });

    const res = await request(buildApp())
      .patch("/api/ordenes/100/estado")
      .set("Authorization", authHeader)
      .send({ estado: "EN_PREPARACION" });

    expect(res.status).toBe(200);
    expect(res.body.estadoEtiqueta).toBe("En preparación");
  });
});

/**
 * Guard del snapshot con promoción.
 *
 * `ItemOrden.precioUnitario` es lo que el cliente PAGÓ, y con una promoción
 * activa eso es el precio efectivo. Guardar el de lista facturaría de más una
 * venta que se cobró de menos — el error más caro que esta feature puede
 * cometer, y uno que no falla en ningún lado: la orden se crea igual.
 */
describe("POST /api/ordenes — snapshot con promoción activa", () => {
  const PRODUCTO = {
    id: 1,
    nombre: "Termo mate",
    precio: { toString: () => "20000" },
    costo: { toString: () => "8000" },
    visibleEnCatalogo: true,
    stock: 5,
  };

  function conPromo(porcentaje) {
    promocionItemFindManyMock.mockResolvedValue([
      { productId: 1, porcentaje, promocion: { id: 3, nombre: "Promo Hogar" } },
    ]);
  }

  function pedir() {
    return request(buildApp())
      .post("/api/ordenes")
      .send({
        dni: "30111222",
        nombre: "Ana",
        telefono: "1155550000",
        email: "ana@test.com",
        items: [{ productId: 1, cantidad: 2 }],
      });
  }

  beforeEach(() => {
    productFindManyMock.mockResolvedValue([PRODUCTO]);
    clienteFindUniqueMock.mockResolvedValue(null);
    clienteCreateMock.mockResolvedValue({ id: 9, dni: "30111222", nombre: "Ana" });
    ordenCreateMock.mockResolvedValue({ id: 100, estado: "PENDIENTE", items: [], cliente: {} });
    productFindUniqueMock.mockResolvedValue(PRODUCTO);
    productUpdateMock.mockResolvedValue(PRODUCTO);
  });

  it("SIN promoción guarda el precio de lista y nada más", async () => {
    // El contrato de "si no hay promoción, todo se comporta como antes".
    await pedir();

    const [item] = ordenCreateMock.mock.calls[0][0].data.items.create;
    expect(item.precioUnitario).toBe("20000");
    expect(item.precioListaUnitario).toBeNull();
    expect(item.descuentoPorcentaje).toBeNull();
  });

  it("CON promoción guarda lo que el cliente PAGÓ", async () => {
    conPromo(15);

    await pedir();

    const [item] = ordenCreateMock.mock.calls[0][0].data.items.create;
    expect(item.precioUnitario).toBe("17000");
  });

  it("guarda además el precio de lista y el porcentaje", async () => {
    // Sin estas dos columnas, "¿cuánta plata regalé en la campaña?" no se puede
    // contestar nunca: el precio de lista puede cambiar en cualquier momento.
    conPromo(15);

    await pedir();

    const [item] = ordenCreateMock.mock.calls[0][0].data.items.create;
    expect(item.precioListaUnitario).toBe("20000");
    expect(item.descuentoPorcentaje).toBe(15);
  });

  it("el COSTO no lo toca el descuento", async () => {
    // El costo es lo que el negocio pagó por la mercadería: un descuento come
    // margen, no baja el costo. Tocarlo escondería exactamente el efecto que la
    // promoción tiene sobre la ganancia.
    conPromo(15);

    await pedir();

    const [item] = ordenCreateMock.mock.calls[0][0].data.items.create;
    expect(item.costoUnitario).toBe("8000");
  });

  it("una promoción que YA NO está vigente no se aplica", async () => {
    // La consulta filtra por vigencia. Si no devuelve nada, la orden se cobra
    // al precio de lista.
    promocionItemFindManyMock.mockResolvedValue([]);

    await pedir();

    expect(ordenCreateMock.mock.calls[0][0].data.items.create[0].precioUnitario).toBe("20000");
  });

  it("el descuento se resuelve en UNA consulta para toda la orden", async () => {
    conPromo(15);

    await pedir();

    expect(promocionItemFindManyMock).toHaveBeenCalledTimes(1);
  });
});
