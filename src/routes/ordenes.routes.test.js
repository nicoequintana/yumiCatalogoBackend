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

const notificarOrdenCreadaMock = vi.fn();
const notificarCambioEstadoMock = vi.fn();

vi.mock("../services/notificacionesOrden.service.js", () => ({
  notificarOrdenCreada: (...args) => notificarOrdenCreadaMock(...args),
  notificarCambioEstado: (...args) => notificarCambioEstadoMock(...args),
}));

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
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: (...args) => auditCreateMock(...args) },
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
  auditCreateMock.mockReset();
  auditCreateMock.mockResolvedValue({ id: 1 });
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
  eventoTraficoCreateMock.mockReset();
  eventoTraficoCreateMock.mockResolvedValue({});
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
