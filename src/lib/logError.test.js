import { describe, expect, it, vi, beforeEach } from "vitest";

const createMock = vi.fn();

vi.mock("./prisma.js", () => ({
  prisma: {
    errorLog: {
      create: (...args) => createMock(...args),
    },
  },
}));

const { logError } = await import("./logError.js");

beforeEach(() => {
  createMock.mockReset();
});

describe("logError", () => {
  it("inserta un registro en errorLog con los campos esperados", async () => {
    createMock.mockResolvedValue({ id: 1 });

    await logError({
      mensaje: "Algo falló",
      stack: "Error: Algo falló\n  at foo.js:1:1",
      ruta: "/api/products",
      metodo: "GET",
      status: 500,
    });

    expect(createMock).toHaveBeenCalledWith({
      data: {
        mensaje: "Algo falló",
        stack: "Error: Algo falló\n  at foo.js:1:1",
        ruta: "/api/products",
        metodo: "GET",
        status: 500,
      },
    });
  });

  it("no lanza si prisma.errorLog.create rechaza (best-effort)", async () => {
    createMock.mockRejectedValue(new Error("DB caída"));

    await expect(
      logError({ mensaje: "Algo falló", stack: null, ruta: "/api/products", metodo: "GET", status: 500 })
    ).resolves.not.toThrow();
  });
});
