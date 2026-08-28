import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadStreamMock = vi.fn();

/**
 * Listado de una carpeta de Cloudinary.
 *
 * El SDK está mockeado: la suite no sale a la red. Lo que se afirma acá es
 * POR QUÉ CAMPO se consulta, porque una consulta al campo equivocado no falla
 * — devuelve cero resultados y la pantalla dice "todavía no hay imágenes"
 * sobre una carpeta llena. Ver el comentario de `listarImagenesDeCarpeta`.
 */
const apiResourcesPorCarpetaMock = vi.fn();

vi.mock("cloudinary", () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      upload_stream: (...args) => uploadStreamMock(...args),
      destroy: vi.fn(),
    },
    api: {
      delete_folder: vi.fn(),
      resources_by_asset_folder: (...args) => apiResourcesPorCarpetaMock(...args),
    },
  },
}));

process.env.CLOUDINARY_CLOUD_NAME = "test";
process.env.CLOUDINARY_API_KEY = "test";
process.env.CLOUDINARY_API_SECRET = "test";

const { subirArchivo, listarImagenesDeCarpeta } = await import("./cloudinary.service.js");

describe("subirArchivo — errores del SDK", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CLOUDINARY_CLOUD_NAME = "test";
    process.env.CLOUDINARY_API_KEY = "test";
    process.env.CLOUDINARY_API_SECRET = "test";
  });

  it("convierte el objeto plano de error del SDK en un Error real con status 502", async () => {
    // Caso real (2026-08-20): un upload estancado hace que el SDK rechace con
    // {message: "Request Timeout", http_code: 499} — un objeto plano, sin
    // stack. Eso llegaba al handler global como 500 "Error interno del
    // servidor" y al ErrorLog sin stack: doble mentira para el operador.
    uploadStreamMock.mockImplementation((_opciones, callback) => ({
      end: () => callback({ message: "Request Timeout", http_code: 499 }, undefined),
    }));

    const promesa = subirArchivo(Buffer.from("x"), "image");

    await expect(promesa).rejects.toBeInstanceOf(Error);
    await expect(promesa).rejects.toMatchObject({ status: 502 });
    await expect(promesa).rejects.toThrow(/Cloudinary/);
    await expect(promesa).rejects.toThrow(/Request Timeout/);
    // Un Error real trae stack: el ErrorLog deja de mostrar "—".
    await promesa.catch((err) => expect(err.stack).toBeTruthy());
  });

  it("el camino feliz sigue devolviendo la forma de siempre", async () => {
    uploadStreamMock.mockImplementation((_opciones, callback) => ({
      end: () =>
        callback(undefined, { public_id: "productos/1/foto", resource_type: "image", secure_url: "https://cdn/x.jpg" }),
    }));

    await expect(subirArchivo(Buffer.from("x"), "image")).resolves.toEqual({
      cloudinaryPublicId: "productos/1/foto",
      cloudinaryResourceType: "image",
      url: "https://cdn/x.jpg",
    });
  });
});

describe("listarImagenesDeCarpeta", () => {
  beforeEach(() => vi.clearAllMocks());

  it("consulta por asset_folder, NO por prefijo de public_id", async () => {
    // Esta cuenta usa dynamic folders: la carpeta es un atributo del asset y
    // no vive dentro del `public_id`. Preguntar por prefijo devuelve cero
    // resultados SIN ERROR, que es peor que fallar — la pantalla informa
    // "todavía no hay imágenes generadas" sobre una carpeta con archivos.
    apiResourcesPorCarpetaMock.mockResolvedValue({ resources: [] });

    await listarImagenesDeCarpeta("productos/YIMA-TERMOM-8189");

    expect(apiResourcesPorCarpetaMock).toHaveBeenCalledWith(
      "productos/YIMA-TERMOM-8189",
      expect.objectContaining({ max_results: expect.any(Number) }),
    );
  });

  it("la carpeta va SIN barra final: la coincidencia del endpoint es exacta", async () => {
    // El filtro por prefijo anterior necesitaba la barra para que
    // `productos/YIMA-ABC` no matcheara `productos/YIMA-ABCD-123`. Este
    // endpoint compara la carpeta entera, así que agregarla la vuelve una
    // carpeta distinta y no encuentra nada.
    apiResourcesPorCarpetaMock.mockResolvedValue({ resources: [] });

    await listarImagenesDeCarpeta("productos/YIMA-TERMOM-8189");

    expect(apiResourcesPorCarpetaMock.mock.calls[0][0]).toBe("productos/YIMA-TERMOM-8189");
  });

  it("encuentra las imágenes de n8n, cuyo public_id NO trae la ruta", async () => {
    // Este es el caso que se rompía en producción: n8n sube con el public_id
    // pelado (`YIMA-TERMOM-8189-1`), sin carpeta adentro.
    apiResourcesPorCarpetaMock.mockResolvedValue({
      resources: [
        {
          public_id: "YIMA-TERMOM-8189-1",
          resource_type: "image",
          secure_url: "https://res.cloudinary.com/x/image/upload/YIMA-TERMOM-8189-1",
        },
      ],
    });

    const salida = await listarImagenesDeCarpeta("productos/YIMA-TERMOM-8189");

    expect(salida).toEqual([
      {
        publicId: "YIMA-TERMOM-8189-1",
        url: "https://res.cloudinary.com/x/image/upload/YIMA-TERMOM-8189-1",
        nombre: "YIMA-TERMOM-8189-1",
      },
    ]);
  });

  it("también mapea un public_id que SÍ trae la ruta (subida del catálogo)", async () => {
    // El catálogo sube con `folder:` y sus assets conservan la ruta en el
    // public_id. Las dos formas conviven en la misma cuenta.
    apiResourcesPorCarpetaMock.mockResolvedValue({
      resources: [
        {
          public_id: "productos/YIMA-TERMOM-8189/abc123",
          resource_type: "image",
          secure_url: "https://cdn/abc123.png",
        },
      ],
    });

    const salida = await listarImagenesDeCarpeta("productos/YIMA-TERMOM-8189");

    expect(salida).toEqual([
      { publicId: "productos/YIMA-TERMOM-8189/abc123", url: "https://cdn/abc123.png", nombre: "abc123" },
    ]);
  });

  it("descarta lo que no sea imagen", async () => {
    // Una carpeta de assets puede tener tipos mezclados; el flujo de n8n solo
    // genera imágenes y la galería no sabe mostrar otra cosa.
    apiResourcesPorCarpetaMock.mockResolvedValue({
      resources: [
        { public_id: "X-1", resource_type: "image", secure_url: "u1" },
        { public_id: "X-2", resource_type: "video", secure_url: "u2" },
      ],
    });

    const salida = await listarImagenesDeCarpeta("productos/X");

    expect(salida.map((i) => i.publicId)).toEqual(["X-1"]);
  });

  it("una carpeta inexistente devuelve lista vacía, no un error", async () => {
    // Es el estado normal de un producto al que todavía no se le generó nada.
    // El endpoint responde 404 "Folder doesn't exist", verificado contra la
    // cuenta real.
    const err = new Error("Folder doesn't exist");
    err.error = { http_code: 404 };
    apiResourcesPorCarpetaMock.mockRejectedValue(err);

    await expect(listarImagenesDeCarpeta("productos/NO-EXISTE")).resolves.toEqual([]);
  });

  it("ordena por nombre de archivo, para que -1 quede antes que -2", async () => {
    apiResourcesPorCarpetaMock.mockResolvedValue({
      resources: [
        { public_id: "X-3", resource_type: "image", secure_url: "u3" },
        { public_id: "X-1", resource_type: "image", secure_url: "u1" },
        { public_id: "X-2", resource_type: "image", secure_url: "u2" },
      ],
    });

    const salida = await listarImagenesDeCarpeta("productos/X");

    expect(salida.map((i) => i.nombre)).toEqual(["X-1", "X-2", "X-3"]);
  });

  it("propaga un error que no sea 404", async () => {
    const err = new Error("Unauthorized");
    err.error = { http_code: 401 };
    apiResourcesPorCarpetaMock.mockRejectedValue(err);

    await expect(listarImagenesDeCarpeta("productos/X")).rejects.toThrow();
  });
});
