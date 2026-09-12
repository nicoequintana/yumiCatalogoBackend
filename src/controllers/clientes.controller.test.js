import { describe, expect, it, vi, beforeEach } from "vitest";
import { LISTADO_ORDEN_INCLUDE, mapOrdenListado } from "./ordenes.mapper.js";

const ordenFindManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    orden: {
      findMany: (...args) => ordenFindManyMock(...args),
    },
  },
}));

const { obtenerHistorialCliente, MAX_ORDENES_HISTORIAL } = await import("./clientes.controller.js");

function buildReqRes({ params } = {}) {
  const req = { params: params ?? {} };
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

const ORDEN_1 = {
  id: 1,
  clienteId: 10,
  estado: "ENTREGADA",
  cliente: { nombre: "Juan", dni: "12345678", telefono: "1", email: "a@a.com" },
  cuentaCliente: null,
  items: [{ nombreProducto: "Producto A", precioUnitario: "100.00", costoUnitario: "40.00", cantidad: 1 }],
  createdAt: new Date("2026-01-02"),
};

const ORDEN_2 = {
  id: 2,
  clienteId: 10,
  estado: "PENDIENTE",
  cliente: { nombre: "Juan", dni: "12345678", telefono: "1", email: "a@a.com" },
  cuentaCliente: { id: 5, nombre: "Nombre De Cuenta", telefono: "2", email: "b@b.com" },
  items: [{ nombreProducto: "Producto B", precioUnitario: "50.00", costoUnitario: "20.00", cantidad: 3 }],
  createdAt: new Date("2026-01-05"),
};

beforeEach(() => {
  ordenFindManyMock.mockReset();
});

describe("obtenerHistorialCliente()", () => {
  it("devuelve las órdenes del cliente mapeadas con mapOrdenListado (createdAt desc)", async () => {
    ordenFindManyMock.mockResolvedValue([ORDEN_2, ORDEN_1]);

    const { req, res, next } = buildReqRes({ params: { dni: "12345678" } });
    await obtenerHistorialCliente(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(ordenFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cliente: { dni: "12345678" } },
        orderBy: { createdAt: "desc" },
        include: LISTADO_ORDEN_INCLUDE,
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([ORDEN_2, ORDEN_1].map(mapOrdenListado));
  });

  it("NO emite costoUnitario línea por línea (la fila cruda de Prisma lo traía)", async () => {
    ordenFindManyMock.mockResolvedValue([ORDEN_1]);

    const { req, res } = buildReqRes({ params: { dni: "12345678" } });
    await obtenerHistorialCliente(req, res, vi.fn());

    expect(JSON.stringify(res.body)).not.toContain("costoUnitario");
  });

  it("emite estadoEtiqueta, total y resumen (forma de listado, no la fila cruda)", async () => {
    ordenFindManyMock.mockResolvedValue([ORDEN_2]);

    const { req, res } = buildReqRes({ params: { dni: "12345678" } });
    await obtenerHistorialCliente(req, res, vi.fn());

    expect(res.body[0].estadoEtiqueta).toBe("Pendiente");
    expect(res.body[0].total).toBe("150");
    expect(res.body[0].cantidadItems).toBe(1);
    expect(res.body[0].resumen).toEqual([{ nombreProducto: "Producto B", cantidad: 3 }]);
    expect(res.body[0].items).toBeUndefined();
  });

  it("el nombre del cliente resuelve desde cuentaCliente cuando la orden tiene una", async () => {
    ordenFindManyMock.mockResolvedValue([ORDEN_2]);

    const { req, res } = buildReqRes({ params: { dni: "12345678" } });
    await obtenerHistorialCliente(req, res, vi.fn());

    expect(res.body[0].cliente.nombre).toBe("Nombre De Cuenta");
  });

  it("normaliza el DNI de la URL antes de consultar ('12.345.678' -> '12345678')", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const { req, res, next } = buildReqRes({ params: { dni: "12.345.678" } });
    await obtenerHistorialCliente(req, res, next);

    expect(ordenFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { cliente: { dni: "12345678" } } }),
    );
  });

  it("acota la consulta a un tope de filas, conservando las más recientes", async () => {
    // Sin `take`, el historial de un cliente crecía sin techo. El orderBy
    // desc ya existente hace que el tope conserve las órdenes más nuevas.
    ordenFindManyMock.mockResolvedValue([]);

    const { req, res, next } = buildReqRes({ params: { dni: "12345678" } });
    await obtenerHistorialCliente(req, res, next);

    expect(MAX_ORDENES_HISTORIAL).toBeGreaterThan(0);
    expect(ordenFindManyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        take: MAX_ORDENES_HISTORIAL,
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("devuelve un array vacío (no 404) si no hay cliente con ese DNI", async () => {
    ordenFindManyMock.mockResolvedValue([]);

    const { req, res, next } = buildReqRes({ params: { dni: "99999999" } });
    await obtenerHistorialCliente(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });
});
