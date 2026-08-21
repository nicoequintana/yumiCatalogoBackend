import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadStreamMock = vi.fn();

vi.mock("cloudinary", () => ({
  v2: {
    config: vi.fn(),
    uploader: {
      upload_stream: (...args) => uploadStreamMock(...args),
      destroy: vi.fn(),
    },
    api: { delete_folder: vi.fn() },
  },
}));

const { subirArchivo } = await import("./cloudinary.service.js");

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
