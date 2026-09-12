import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

process.env.JWT_SECRET = "test-secret";
process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.CORS_ORIGIN = "http://localhost:5173";
process.env.COOKIE_DOMINIO = "";

// Los limitadores de `limitadoresCuenta.js` tienen store en memoria por
// proceso: se neutralizan acá igual que en `cuenta.routes.parte2b.test.js`,
// para que ningún test de esta suite reciba un 429 en vez del status que
// afirma. Su comportamiento se prueba en `rateLimit.middleware.test.js`.
vi.mock("../middlewares/rateLimit.middleware.js", () => ({
  crearLimitadorDeVelocidad: () => (_req, _res, next) => next(),
}));

// `requireCliente` real depende de la cookie `sesion_cliente` + `jwtCliente.js`
// (Parte 1) y tiene su propia suite (`authCliente.middleware.test.js`). Acá se
// mockea a un middleware controlable por el header de prueba `x-test-cuenta`
// — mismo criterio con el que `ordenes.routes.test.js` mockea
// `authClienteOpcional`. El header no existe fuera de tests.
vi.mock("../middlewares/authCliente.middleware.js", () => ({
  requireCliente: (req, res, next) => {
    const header = req.get("x-test-cuenta");
    if (!header) {
      return res.status(401).json({ error: "No autorizado.", codigo: "SESION_INVALIDA" });
    }
    req.cuentaCliente = JSON.parse(header);
    next();
  },
  authClienteOpcional: (req, _res, next) => {
    req.cuentaCliente = null;
    next();
  },
}));

// El error handler real escribe `ErrorLog`; el mock de prisma de acá no tiene
// esa tabla y el fire-and-forget explotaría por una razón ajena a lo que estos
// tests afirman.
vi.mock("../lib/logError.js", () => ({ logError: vi.fn() }));

const ordenFindManyMock = vi.fn();
const ordenFindFirstMock = vi.fn();
const ordenFindUniqueMock = vi.fn();
const ordenCountMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    orden: {
      findMany: (...args) => ordenFindManyMock(...args),
      findFirst: (...args) => ordenFindFirstMock(...args),
      findUnique: (...args) => ordenFindUniqueMock(...args),
      count: (...args) => ordenCountMock(...args),
    },
    cuentaCliente: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

const { manejadorDeErrores } = await import("../middlewares/errorHandler.js");
const { DETALLE_ORDEN_CUENTA_INCLUDE, LISTADO_ORDEN_CUENTA_INCLUDE } = await import(
  "../controllers/ordenes.mapper.js"
);
const { default: cuentaRouter } = await import("./cuenta.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/cuenta", cuentaRouter);
  app.use(manejadorDeErrores);
  return app;
}

const CUENTA_HEADER = JSON.stringify({ id: 9, email: "cuenta@gmail.com" });

/** Una fila cruda de orden como la devuelve Prisma, con las claves que el
 * mapper del comprador tiene que DESCARTAR. */
function filaDeOrden({ id = 1, cuentaClienteId = 9 } = {}) {
  return {
    id,
    estado: "PENDIENTE",
    createdAt: new Date("2026-09-01T10:00:00Z"),
    cuentaClienteId,
    clienteId: 77,
    items: [{ nombreProducto: "Taladro", precioUnitario: "1000", cantidad: 2, product: { fotos: [] } }],
  };
}

beforeEach(() => {
  ordenFindManyMock.mockReset();
  ordenFindFirstMock.mockReset();
  ordenFindUniqueMock.mockReset();
  ordenCountMock.mockReset();
});

describe("GET /api/cuenta/ordenes", () => {
  it("responde 401 SESION_INVALIDA sin sesión, sin consultar la base", async () => {
    const res = await request(buildApp()).get("/api/cuenta/ordenes");

    expect(res.status).toBe(401);
    expect(res.body.codigo).toBe("SESION_INVALIDA");
    expect(ordenFindManyMock).not.toHaveBeenCalled();
    expect(ordenCountMock).not.toHaveBeenCalled();
  });

  it("filtra por el cuentaClienteId de la SESIÓN, con equals explícito", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/cuenta/ordenes").set("x-test-cuenta", CUENTA_HEADER);

    expect(ordenFindManyMock.mock.calls[0][0].where).toEqual({ cuentaClienteId: { equals: 9 } });
    expect(ordenCountMock.mock.calls[0][0].where).toEqual({ cuentaClienteId: { equals: 9 } });
  });

  it("ignora cualquier cuentaClienteId que venga por query string", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    await request(buildApp())
      .get("/api/cuenta/ordenes?cuentaClienteId=999&clienteId=999&dni=12345678")
      .set("x-test-cuenta", CUENTA_HEADER);

    expect(ordenFindManyMock.mock.calls[0][0].where).toEqual({ cuentaClienteId: { equals: 9 } });
  });

  it("usa el include del comprador y ordena por createdAt desc", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    await request(buildApp()).get("/api/cuenta/ordenes").set("x-test-cuenta", CUENTA_HEADER);

    const args = ordenFindManyMock.mock.calls[0][0];
    expect(args.include).toBe(LISTADO_ORDEN_CUENTA_INCLUDE);
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("responde el sobre {data, page, pageSize, total} sin filtrar contacto", async () => {
    ordenFindManyMock.mockResolvedValue([filaDeOrden()]);
    ordenCountMock.mockResolvedValue(1);

    const res = await request(buildApp()).get("/api/cuenta/ordenes").set("x-test-cuenta", CUENTA_HEADER);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: 1, cantidadItems: 1, total: "2000" });
    expect(res.body.data[0]).not.toHaveProperty("cliente");
    expect(res.body.data[0]).not.toHaveProperty("cuentaCliente");
    expect(res.body.data[0]).not.toHaveProperty("clienteId");
    expect(res.body.data[0]).not.toHaveProperty("cuentaClienteId");
    expect(res.body.data[0]).not.toHaveProperty("items");
  });

  it("pagina con el parser compartido (page/pageSize → skip/take)", async () => {
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    await request(buildApp())
      .get("/api/cuenta/ordenes?page=3&pageSize=5")
      .set("x-test-cuenta", CUENTA_HEADER);

    const args = ordenFindManyMock.mock.calls[0][0];
    expect(args.skip).toBe(10);
    expect(args.take).toBe(5);
  });

  it("decisión 3: una cuenta cuyo DNI coincide con compras de invitado ve total 0", async () => {
    // El filtro es por `cuentaClienteId`, NUNCA por DNI: aunque la base tuviera
    // órdenes de invitado con el mismo DNI, este `where` no las puede alcanzar.
    ordenFindManyMock.mockResolvedValue([]);
    ordenCountMock.mockResolvedValue(0);

    const res = await request(buildApp()).get("/api/cuenta/ordenes").set("x-test-cuenta", CUENTA_HEADER);

    expect(res.body.total).toBe(0);
    expect(ordenFindManyMock.mock.calls[0][0].where).not.toHaveProperty("cliente");
  });

  it("con un id de sesión no entero corta con 500 y NO consulta la base", async () => {
    // `cuentaClienteId: { equals: undefined }` es un no-op para Prisma: el
    // `where` se descarta y la consulta devolvería las órdenes de TODAS las
    // cuentas. Se prefiere el 500 explícito.
    const res = await request(buildApp())
      .get("/api/cuenta/ordenes")
      .set("x-test-cuenta", JSON.stringify({ id: "9", email: "cuenta@gmail.com" }));

    expect(res.status).toBe(500);
    expect(ordenFindManyMock).not.toHaveBeenCalled();
    expect(ordenCountMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/cuenta/ordenes/:id", () => {
  it("responde 401 SESION_INVALIDA sin sesión, sin consultar la base", async () => {
    const res = await request(buildApp()).get("/api/cuenta/ordenes/1");

    expect(res.status).toBe(401);
    expect(res.body.codigo).toBe("SESION_INVALIDA");
    expect(ordenFindFirstMock).not.toHaveBeenCalled();
  });

  it("scopea por id Y cuentaClienteId en la MISMA consulta, con el include del comprador", async () => {
    ordenFindFirstMock.mockResolvedValue(filaDeOrden());

    await request(buildApp()).get("/api/cuenta/ordenes/1").set("x-test-cuenta", CUENTA_HEADER);

    const args = ordenFindFirstMock.mock.calls[0][0];
    expect(args.where).toEqual({ id: 1, cuentaClienteId: 9 });
    expect(args.include).toBe(DETALLE_ORDEN_CUENTA_INCLUDE);
    // Nunca un `findUnique` por id solo: eso sería traer la orden ajena a
    // memoria y recién ahí compararla.
    expect(ordenFindUniqueMock).not.toHaveBeenCalled();
  });

  it("responde 200 con la orden mapeada cuando es propia, sin contacto ni ids de dueño", async () => {
    ordenFindFirstMock.mockResolvedValue(filaDeOrden());

    const res = await request(buildApp()).get("/api/cuenta/ordenes/1").set("x-test-cuenta", CUENTA_HEADER);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(res.body.estadoEtiqueta).toBeTruthy();
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).not.toHaveProperty("costoUnitario");
    expect(res.body).not.toHaveProperty("cliente");
    expect(res.body).not.toHaveProperty("cuentaCliente");
    expect(res.body).not.toHaveProperty("clienteId");
    expect(res.body).not.toHaveProperty("cuentaClienteId");
  });

  it("una orden AJENA es indistinguible de una inexistente (mismo status y cuerpo)", async () => {
    // El mock emula lo que hace la base con el `where` real: la fila de la
    // cuenta 999 no matchea el scope de la sesión 9, así que Prisma no
    // devuelve nada. Si el handler leyera por id solo, acá recibiría la orden
    // ajena y tendría que acordarse de compararla.
    const enLaBase = filaDeOrden({ id: 1, cuentaClienteId: 999 });
    ordenFindFirstMock.mockImplementation(async ({ where }) =>
      where.id === enLaBase.id && where.cuentaClienteId === enLaBase.cuentaClienteId ? enLaBase : null,
    );

    const ajena = await request(buildApp()).get("/api/cuenta/ordenes/1").set("x-test-cuenta", CUENTA_HEADER);
    const inexistente = await request(buildApp())
      .get("/api/cuenta/ordenes/4242")
      .set("x-test-cuenta", CUENTA_HEADER);

    expect(ajena.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(ajena.body).toEqual(inexistente.body);
  });

  it("responde 404 para una orden inexistente", async () => {
    ordenFindFirstMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/cuenta/ordenes/999").set("x-test-cuenta", CUENTA_HEADER);

    expect(res.status).toBe(404);
  });

  it("responde 404 para un id no numérico, sin consultar la base", async () => {
    const res = await request(buildApp()).get("/api/cuenta/ordenes/abc").set("x-test-cuenta", CUENTA_HEADER);

    expect(res.status).toBe(404);
    expect(ordenFindFirstMock).not.toHaveBeenCalled();
  });

  it("responde 404 para un id fraccionario o fuera de rango, sin consultar la base", async () => {
    const app = buildApp();

    for (const id of ["1.5", "9007199254740993", "1e21", "-1"]) {
      const res = await request(app).get(`/api/cuenta/ordenes/${id}`).set("x-test-cuenta", CUENTA_HEADER);
      expect(res.status, `id=${id}`).toBe(404);
    }
    expect(ordenFindFirstMock).not.toHaveBeenCalled();
  });

  it("con un id de sesión no entero corta con 500 y NO consulta la base", async () => {
    const res = await request(buildApp())
      .get("/api/cuenta/ordenes/1")
      .set("x-test-cuenta", JSON.stringify({ id: null, email: "cuenta@gmail.com" }));

    expect(res.status).toBe(500);
    expect(ordenFindFirstMock).not.toHaveBeenCalled();
  });
});
