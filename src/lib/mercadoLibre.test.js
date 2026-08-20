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

describe("crearClienteML — dossier", () => {
  function clienteCon(fetchMock) {
    return crearClienteML({ clientId: "id", clientSecret: "sec", fetch: fetchMock });
  }

  const TOKEN_OK = { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 21600 }) };

  it("arma el dossier completo cuando /items responde (caso futuro)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: "MLA1",
          title: "Lámpara Nómade",
          price: 48900,
          attributes: [
            { name: "Material", value_name: "Aluminio" },
            { name: "Color", value_name: null },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ plain_text: "Texto libre." }) });

    const dossier = await clienteCon(fetchMock).traerDossier("MLA1");

    expect(dossier).toEqual({
      titulo: "Lámpara Nómade",
      precioML: 48900,
      atributos: [{ nombre: "Material", valor: "Aluminio" }],
      descripcionML: "Texto libre.",
    });
  });

  it("degrada con gracia cuando /items da 403 pero la descripción responde (caso real hoy)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "access_denied" }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ plain_text: "Solo la descripción." }) });

    const dossier = await clienteCon(fetchMock).traerDossier("MLA1");

    expect(dossier).toEqual({
      titulo: null,
      precioML: null,
      atributos: [],
      descripcionML: "Solo la descripción.",
    });
  });

  it("tolera que la descripción no exista si el ítem respondió", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ title: "X", price: 1, attributes: [] }) })
      .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });

    const dossier = await clienteCon(fetchMock).traerDossier("MLA1");
    expect(dossier.descripcionML).toBe("");
    expect(dossier.titulo).toBe("X");
  });

  it("lanza un error legible cuando NINGUNA de las dos fuentes responde", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "access_denied" }) })
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: "access_denied" }) });

    await expect(clienteCon(fetchMock).traerDossier("MLA1")).rejects.toThrow(/MLA1/);
  });

  it("reintenta UNA vez con token nuevo ante un 401 inesperado", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_OK) // token 1
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) }) // items con token viejo
      .mockResolvedValueOnce(TOKEN_OK) // token 2 (renovado)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ title: "X", price: 1, attributes: [] }) }) // items reintentado
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ plain_text: "d" }) }); // descripción

    const dossier = await clienteCon(fetchMock).traerDossier("MLA1");
    expect(dossier.titulo).toBe("X");
  });

  it("contextualiza un fallo de red en vez de tirar el error crudo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_OK)
      .mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(clienteCon(fetchMock).traerDossier("MLA1")).rejects.toThrow(/No se pudo conectar con MercadoLibre/);
  });

  it("un 200 con JSON roto en /items degrada igual que un 403", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token <");
        },
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ plain_text: "d" }) });

    const dossier = await clienteCon(fetchMock).traerDossier("MLA1");
    expect(dossier.titulo).toBeNull();
    expect(dossier.descripcionML).toBe("d");
  });

  it("lanza error legible si la descripción responde 200 pero con basura y /items está cerrado", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("basura");
        },
      });

    await expect(clienteCon(fetchMock).traerDossier("MLA1")).rejects.toThrow(/MLA1/);
  });

  it("si el reintento también da 401, devuelve esa respuesta sin reintentar de nuevo", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_OK) // token inicial
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) }) // items, 1er intento
      .mockResolvedValueOnce(TOKEN_OK) // token renovado
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) }) // items, reintento: también 401
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ plain_text: "d" }) }); // descripción

    const dossier = await clienteCon(fetchMock).traerDossier("MLA1");
    // El ítem quedó inaccesible pero la descripción alcanza: degrada, no revienta.
    expect(dossier.titulo).toBeNull();
    expect(dossier.descripcionML).toBe("d");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("si la renovación del token falla durante el reintento, el error es el de credenciales", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(TOKEN_OK)
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ message: "invalid_client" }) }); // renovación falla

    await expect(clienteCon(fetchMock).traerDossier("MLA1")).rejects.toThrow(/credenciales/i);
  });
});
