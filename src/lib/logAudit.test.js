import { describe, expect, it, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("./prisma.js", () => ({
  prisma: {
    auditLog: {
      create: (...args) => createMock(...args),
    },
  },
}));

const { logAudit } = await import("./logAudit.js");

beforeEach(() => {
  createMock.mockReset();
});

function reqFalso({ usuario, originalUrl = "/api/products/1", method = "PUT", ip = "10.0.0.1" } = {}) {
  return { usuario, originalUrl, method, ip };
}

describe("logAudit", () => {
  it("inserta un registro en auditLog con los campos esperados", async () => {
    createMock.mockResolvedValue({ id: 1 });

    await logAudit(reqFalso({ usuario: { id: 7, email: "admin@yima.test" } }), {
      accion: "ACTUALIZAR",
      entidad: "Producto",
      entidadId: 1,
      detalle: { nombre: "Vela de soja" },
    });

    expect(createMock).toHaveBeenCalledWith({
      data: {
        usuarioId: 7,
        usuarioEmail: "admin@yima.test",
        accion: "ACTUALIZAR",
        entidad: "Producto",
        entidadId: 1,
        detalle: JSON.stringify({ nombre: "Vela de soja" }),
        ruta: "/api/products/1",
        metodo: "PUT",
        ip: "10.0.0.1",
      },
    });
  });

  it("no lanza si prisma.auditLog.create rechaza (best-effort)", async () => {
    createMock.mockRejectedValue(new Error("DB caída"));

    await expect(
      logAudit(reqFalso({ usuario: { id: 1, email: "admin@yima.test" } }), {
        accion: "ELIMINAR",
        entidad: "Producto",
        entidadId: 3,
      }),
    ).resolves.not.toThrow();
  });

  it("no lanza si el req no trae usuario (token viejo sin email) y usa un placeholder", async () => {
    createMock.mockResolvedValue({ id: 1 });

    await logAudit(reqFalso({ usuario: undefined }), { accion: "CREAR", entidad: "Categoria", entidadId: 2 });

    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ usuarioId: null, usuarioEmail: "desconocido" }),
    });
  });

  it("acepta un detalle que ya viene como string y lo guarda tal cual", async () => {
    createMock.mockResolvedValue({ id: 1 });

    await logAudit(reqFalso(), { accion: "ACTUALIZAR", entidad: "Orden", entidadId: 5, detalle: "PENDIENTE -> CONFIRMADA" });

    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ detalle: "PENDIENTE -> CONFIRMADA" }),
    });
  });

  it("guarda detalle null cuando no se pasa ninguno", async () => {
    createMock.mockResolvedValue({ id: 1 });

    await logAudit(reqFalso(), { accion: "ELIMINAR", entidad: "Categoria", entidadId: 9 });

    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ detalle: null }),
    });
  });

  it("no lanza si el detalle tiene una referencia circular (JSON.stringify falla)", async () => {
    createMock.mockResolvedValue({ id: 1 });
    const circular = { nombre: "loop" };
    circular.self = circular;

    await expect(
      logAudit(reqFalso(), { accion: "ACTUALIZAR", entidad: "Producto", entidadId: 1, detalle: circular }),
    ).resolves.not.toThrow();

    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ detalle: null }),
    });
  });

  it("trunca una ruta más larga que su columna para que la traza no se pierda por P2000", async () => {
    createMock.mockResolvedValue({ id: 1 });

    // `AuditLog.ruta` es NVarChar(1000). Una URL armada a propósito más larga
    // hacía fallar el insert best-effort y la traza de auditoría de una
    // mutación del admin se perdía SIN AVISO. Se recorta en origen.
    const rutaGigante = `/api/products/1?x=${"a".repeat(3000)}`;

    await logAudit(reqFalso({ usuario: { id: 1, email: "admin@yima.test" }, originalUrl: rutaGigante }), {
      accion: "ACTUALIZAR",
      entidad: "Producto",
      entidadId: 1,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const dataPasada = createMock.mock.calls[0][0].data;
    expect(dataPasada.ruta).toHaveLength(1000);
    expect(dataPasada.ruta).toBe(rutaGigante.slice(0, 1000));
  });

  it("normaliza entidadId ausente a null", async () => {
    createMock.mockResolvedValue({ id: 1 });

    await logAudit(reqFalso(), { accion: "CREAR", entidad: "Producto" });

    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ entidadId: null }),
    });
  });
});
