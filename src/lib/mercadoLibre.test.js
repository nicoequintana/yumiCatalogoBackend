import { beforeEach, describe, expect, it, vi } from "vitest";
import { crearClienteML, extraerIdML } from "./mercadoLibre.js";

describe("extraerIdML", () => {
  it("extrae el id de una URL de artículo con guion", () => {
    expect(extraerIdML("https://articulo.mercadolibre.com.ar/MLA-123456789-lampara-nomade-_JM")).toBe(
      "MLA123456789",
    );
  });

  it("extrae el id de una URL de producto de catálogo", () => {
    expect(extraerIdML("https://www.mercadolibre.com.ar/p/MLA987654321")).toBe("MLA987654321");
  });

  it("ignora query params y fragmentos", () => {
    expect(extraerIdML("https://articulo.mercadolibre.com.ar/MLA-111222333-x-_JM?pdp_filters=a#pos=1")).toBe(
      "MLA111222333",
    );
  });

  it("acepta un id pelado", () => {
    expect(extraerIdML("MLA555")).toBe("MLA555");
  });

  it("devuelve null cuando la URL no tiene un id de ML", () => {
    expect(extraerIdML("https://example.com/producto")).toBeNull();
  });

  it("devuelve null ante entrada vacía", () => {
    expect(extraerIdML("")).toBeNull();
    expect(extraerIdML(null)).toBeNull();
  });
});

describe("crearClienteML — token", () => {
  let fetchMock;

  function respuestaToken(token, expiresIn = 21600) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: token, expires_in: expiresIn }),
    };
  }

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it("pide el token una sola vez y lo reusa", async () => {
    fetchMock.mockResolvedValue(respuestaToken("tok-1"));
    const cliente = crearClienteML({ clientId: "id", clientSecret: "sec", fetch: fetchMock });

    expect(await cliente.obtenerToken()).toBe("tok-1");
    expect(await cliente.obtenerToken()).toBe("tok-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renueva el token cuando expiró", async () => {
    fetchMock
      .mockResolvedValueOnce(respuestaToken("tok-1", 0))
      .mockResolvedValueOnce(respuestaToken("tok-2"));
    const cliente = crearClienteML({ clientId: "id", clientSecret: "sec", fetch: fetchMock });

    expect(await cliente.obtenerToken()).toBe("tok-1");
    expect(await cliente.obtenerToken()).toBe("tok-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falla con mensaje claro si las credenciales no sirven", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: "invalid_client" }) });
    const cliente = crearClienteML({ clientId: "malo", clientSecret: "malo", fetch: fetchMock });

    await expect(cliente.obtenerToken()).rejects.toThrow(/credenciales/i);
  });
});
