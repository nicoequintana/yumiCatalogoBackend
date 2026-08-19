import { describe, expect, it, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("./prisma.js", () => ({
  prisma: {
    eventoTrafico: {
      create: (...args) => createMock(...args),
    },
  },
}));

const { logEvento, headersDeEvento } = await import("./logEvento.js");

beforeEach(() => {
  createMock.mockReset();
});

describe("logEvento", () => {
  it("inserta un registro en eventoTrafico con los campos esperados", async () => {
    createMock.mockResolvedValue({ id: 1 });

    await logEvento({
      tipo: "VISTA_PRODUCTO",
      productId: 42,
      referrer: "https://yima.example.com/coleccion",
      userAgent: "Mozilla/5.0",
    });

    expect(createMock).toHaveBeenCalledWith({
      data: {
        tipo: "VISTA_PRODUCTO",
        productId: 42,
        referrer: "https://yima.example.com/coleccion",
        userAgent: "Mozilla/5.0",
      },
    });
  });

  it("normaliza a null los campos opcionales que no se pasan", async () => {
    createMock.mockResolvedValue({ id: 2 });

    await logEvento({ tipo: "ORDEN_CREADA" });

    expect(createMock).toHaveBeenCalledWith({
      data: {
        tipo: "ORDEN_CREADA",
        productId: null,
        referrer: null,
        userAgent: null,
      },
    });
  });

  it("normaliza a null los opcionales pasados como undefined explícito", async () => {
    createMock.mockResolvedValue({ id: 3 });

    await logEvento({
      tipo: "COMPARTIDO",
      productId: undefined,
      referrer: undefined,
      userAgent: undefined,
    });

    expect(createMock).toHaveBeenCalledWith({
      data: {
        tipo: "COMPARTIDO",
        productId: null,
        referrer: null,
        userAgent: null,
      },
    });
  });

  it("no lanza si prisma.eventoTrafico.create rechaza (best-effort)", async () => {
    createMock.mockRejectedValue(new Error("DB caída"));

    await expect(logEvento({ tipo: "VISTA_PRODUCTO", productId: 1 })).resolves.not.toThrow();
  });

  it("no lanza aunque el tipo venga vacío — la validación es del caller", async () => {
    createMock.mockResolvedValue({ id: 9 });

    await expect(logEvento({})).resolves.not.toThrow();
  });

  it("deja rastro en console.error como último recurso cuando el insert falla", async () => {
    createMock.mockRejectedValue(new Error("DB caída"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await logEvento({ tipo: "VISTA_PRODUCTO" });

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("headersDeEvento", () => {
  it("extrae Referer y User-Agent de un request de Express", () => {
    const req = {
      get: (nombre) =>
        ({ Referer: "https://yima.example.com/coleccion", "User-Agent": "Mozilla/5.0" })[nombre],
    };

    expect(headersDeEvento(req)).toEqual({
      referrer: "https://yima.example.com/coleccion",
      userAgent: "Mozilla/5.0",
    });
  });

  it("degrada a null cuando los headers no están presentes", () => {
    expect(headersDeEvento({ get: () => undefined })).toEqual({
      referrer: null,
      userAgent: null,
    });
  });

  it("no lanza si el req no tiene get() (doble de test o llamada fuera de Express)", () => {
    expect(() => headersDeEvento({})).not.toThrow();
    expect(headersDeEvento({})).toEqual({ referrer: null, userAgent: null });
  });

  it("no lanza si el req es undefined", () => {
    expect(headersDeEvento(undefined)).toEqual({ referrer: null, userAgent: null });
  });
});
