import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadStreamMock = vi.fn();

/**
 * Listado de una carpeta de Cloudinary.
 *
 * El SDK está mockeado: la suite no sale a la red. Lo que se afirma acá es la
 * FORMA de la consulta —el prefijo exacto— porque un prefijo mal armado no
 * falla, devuelve la media de otros productos.
 */
const apiResourcesMock = vi.fn();

vi.mock("cloudinary", () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      upload_stream: (...args) => uploadStreamMock(...args),
      destroy: vi.fn(),
    },
    api: {
      delete_folder: vi.fn(),
      resources: (...args) => apiResourcesMock(...args),
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

  it("consulta por el prefijo EXACTO de la carpeta, con la barra final", async () => {
    // Sin la barra, `productos/YIMA-ABC` también matchearía
    // `productos/YIMA-ABCD-123`, trayendo la media de otro producto.
    apiResourcesMock.mockResolvedValue({ resources: [] });

    await listarImagenesDeCarpeta("productos/YIMA-TERMOM-8189");

    expect(apiResourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "upload",
        resource_type: "image",
        prefix: "productos/YIMA-TERMOM-8189/",
      }),
    );
  });

  it("mapea cada recurso a publicId, url y nombre de archivo", async () => {
    apiResourcesMock.mockResolvedValue({
      resources: [
        {
          public_id: "productos/YIMA-TERMOM-8189/YIMA-TERMOM-8189-1",
          secure_url: "https://res.cloudinary.com/x/image/upload/v1/productos/YIMA-TERMOM-8189/YIMA-TERMOM-8189-1.png",
        },
      ],
    });

    const salida = await listarImagenesDeCarpeta("productos/YIMA-TERMOM-8189");

    expect(salida).toEqual([
      {
        publicId: "productos/YIMA-TERMOM-8189/YIMA-TERMOM-8189-1",
        url: "https://res.cloudinary.com/x/image/upload/v1/productos/YIMA-TERMOM-8189/YIMA-TERMOM-8189-1.png",
        nombre: "YIMA-TERMOM-8189-1",
      },
    ]);
  });

  it("una carpeta inexistente devuelve lista vacía, no un error", async () => {
    // Es el estado normal de un producto al que todavía no se le generó nada.
    const err = new Error("Not found");
    err.error = { http_code: 404 };
    apiResourcesMock.mockRejectedValue(err);

    await expect(listarImagenesDeCarpeta("productos/NO-EXISTE")).resolves.toEqual([]);
  });

  it("ordena por nombre de archivo, para que -1 quede antes que -2", async () => {
    apiResourcesMock.mockResolvedValue({
      resources: [
        { public_id: "productos/X/X-3", secure_url: "u3" },
        { public_id: "productos/X/X-1", secure_url: "u1" },
        { public_id: "productos/X/X-2", secure_url: "u2" },
      ],
    });

    const salida = await listarImagenesDeCarpeta("productos/X");

    expect(salida.map((i) => i.nombre)).toEqual(["X-1", "X-2", "X-3"]);
  });

  it("propaga un error que no sea 404", async () => {
    const err = new Error("Unauthorized");
    err.error = { http_code: 401 };
    apiResourcesMock.mockRejectedValue(err);

    await expect(listarImagenesDeCarpeta("productos/X")).rejects.toThrow();
  });
});
