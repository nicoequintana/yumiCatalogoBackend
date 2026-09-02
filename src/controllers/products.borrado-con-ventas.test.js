import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Borrar un producto ya no lo bloquea su historial de ventas.
 *
 * Antes, `ItemOrden.product` era `onDelete: NoAction` y el controller
 * pre-chequeaba las ventas para no comerse un P2003, así que un producto que
 * aparecía en CUALQUIER orden era imborrable — incluidas las CANCELADAS, que
 * el propio proyecto no considera ventas (`ESTADOS_FACTURABLES` las excluye).
 *
 * Ahora `productId` es nullable con `onDelete: SetNull`: la base desliga la
 * línea y la orden conserva su contenido legible gracias a los snapshots
 * `nombreProducto` y `precioUnitario`, que existen exactamente para esto.
 *
 * **La contrapartida, elegida a conciencia:** el ranking de productos vendidos
 * pierde para siempre el vínculo con el producto borrado. Por eso el ranking
 * NO puede agrupar por `productId` a secas — ver la última suite.
 */

const findUniqueMock = vi.fn();
const deleteMock = vi.fn();
const itemOrdenCountMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findUnique: (...args) => findUniqueMock(...args),
      delete: (...args) => deleteMock(...args),
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    itemOrden: { count: (...args) => itemOrdenCountMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
  },
}));
vi.mock("../services/cloudinary.service.js", () => ({
  eliminarCarpeta: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/productoMedia.service.js", () => ({
  limpiarArchivosSubidos: vi.fn().mockResolvedValue(undefined),
  limpiarMediaRemota: vi.fn().mockResolvedValue(undefined),
  logFallaDeLimpieza: vi.fn(),
  sanitizarNombreParaCarpeta: (nombre) => nombre,
  subirArchivosNuevos: vi.fn().mockResolvedValue({ fotos: [], video: null }),
}));

const { eliminar } = await import("./products.controller.js");

function buildReqRes({ params = {} } = {}) {
  const req = {
    params,
    usuario: { id: 1, email: "admin@yima.test" },
    originalUrl: "/api/products/1",
    method: "DELETE",
  };
  const res = {
    statusCode: 200,
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
  return { req, res, next: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
  deleteMock.mockResolvedValue({});
  // El producto TIENE ventas: es la condición que antes lo hacía imborrable.
  // Sin esto el mock devolvería `undefined`, la guarda vieja no se dispararía
  // y el test pasaría sin probar nada.
  itemOrdenCountMock.mockResolvedValue(2);
});

describe("eliminar un producto con ventas", () => {
  it("lo borra en vez de rechazarlo con 400", async () => {
    findUniqueMock.mockResolvedValue({
      id: 1,
      nombre: "Termo",
      sku: "YIMA-TERMO-1",
      fotos: [],
      video: null,
    });

    const { req, res, next } = buildReqRes({ params: { id: "1" } });
    await eliminar(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(res.statusCode).toBe(200);
  });

  it("ya no consulta ItemOrden para decidir: la FK lo resuelve sola", async () => {
    findUniqueMock.mockResolvedValue({
      id: 1,
      nombre: "Termo",
      sku: "YIMA-TERMO-1",
      fotos: [],
      video: null,
    });

    const { req, res, next } = buildReqRes({ params: { id: "1" } });
    await eliminar(req, res, next);

    expect(itemOrdenCountMock).not.toHaveBeenCalled();
  });

  it("sigue devolviendo 404 si el producto no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const { req, res, next } = buildReqRes({ params: { id: "999" } });
    await eliminar(req, res, next);

    expect(next.mock.calls[0][0].status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
