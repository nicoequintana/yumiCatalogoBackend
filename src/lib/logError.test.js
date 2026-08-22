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

  it("deja el stack intacto cuando el error no trae causa", async () => {
    createMock.mockResolvedValue({ id: 1 });

    await logError({ mensaje: "Algo falló", stack: "stack original", causa: undefined, status: 500 });

    expect(createMock.mock.calls[0][0].data.stack).toBe("stack original");
  });

  it("adosa al stack una causa que es objeto plano, con todos sus campos", async () => {
    createMock.mockResolvedValue({ id: 1 });

    // Caso real: el SDK de Cloudinary rechaza con `{message, http_code}` y
    // `cloudinary.service.js` lo cuelga de `err.cause` justamente para no
    // perder el `http_code`. `ErrorLog` no tiene columna para la causa, así
    // que si no se adosa al stack ese dato no llega nunca a la base.
    await logError({
      mensaje: "La subida a Cloudinary falló.",
      stack: "Error: La subida a Cloudinary falló.\n  at subirArchivo",
      causa: { message: "Request Timeout", http_code: 499 },
      status: 502,
    });

    const { stack } = createMock.mock.calls[0][0].data;
    expect(stack).toContain("Error: La subida a Cloudinary falló.");
    expect(stack).toContain("Caused by:");
    expect(stack).toContain("Request Timeout");
    expect(stack).toContain("499");
  });

  it("adosa el stack de la causa cuando la causa es un Error", async () => {
    createMock.mockResolvedValue({ id: 1 });
    const causa = new Error("socket hang up");

    await logError({ mensaje: "Falló", stack: "stack externo", causa, status: 500 });

    const { stack } = createMock.mock.calls[0][0].data;
    expect(stack).toContain("stack externo");
    expect(stack).toContain("socket hang up");
  });

  it("no rompe con una causa circular: cae a String() en vez de perder el log", async () => {
    createMock.mockResolvedValue({ id: 1 });
    const causa = { http_code: 500 };
    causa.self = causa;

    await logError({ mensaje: "Falló", stack: "stack externo", causa, status: 500 });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data.stack).toContain("Caused by:");
  });

  it("trunca una ruta más larga que su columna para que el log no se pierda por P2000", async () => {
    createMock.mockResolvedValue({ id: 1 });

    // `ErrorLog.ruta` es NVarChar(1000): la URL la arma el cliente, así que un
    // request malicioso con una ruta gigante hacía fallar el propio insert del
    // log del error. Se recorta en origen; mensaje y stack son NVarChar(Max).
    const rutaGigante = `/api/eventos?x=${"b".repeat(3000)}`;

    await logError({ mensaje: "Falló", stack: null, ruta: rutaGigante, metodo: "POST", status: 500 });

    const dataPasada = createMock.mock.calls[0][0].data;
    expect(dataPasada.ruta).toHaveLength(1000);
    expect(dataPasada.ruta).toBe(rutaGigante.slice(0, 1000));
  });

  it("no lanza si prisma.errorLog.create rechaza (best-effort)", async () => {
    createMock.mockRejectedValue(new Error("DB caída"));

    await expect(
      logError({ mensaje: "Algo falló", stack: null, ruta: "/api/products", metodo: "GET", status: 500 })
    ).resolves.not.toThrow();
  });
});
