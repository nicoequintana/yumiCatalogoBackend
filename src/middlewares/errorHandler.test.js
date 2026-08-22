import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import multer from "multer";

const errorLogCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    errorLog: { create: (...args) => errorLogCreateMock(...args) },
  },
}));

const { manejadorDeErrores } = await import("./errorHandler.js");
const { MAX_FOTOS, MAX_VIDEOS } = await import("../lib/limitesMedios.js");

/**
 * Monta una app mínima cuya única ruta lanza el error que se le pase, para
 * ejercitar el manejador real de punta a punta (status + cuerpo + logueo), no
 * la función suelta.
 */
function appQueLanza(err) {
  const app = express();
  app.get("/boom", (_req, _res, next) => next(err));
  // La misma ruta con otros métodos: el mapeo de P2003 distingue por método
  // HTTP (un DELETE que falla por FK no es lo mismo que un INSERT con una
  // referencia inválida).
  app.post("/boom", (_req, _res, next) => next(err));
  app.delete("/boom", (_req, _res, next) => next(err));
  app.use(manejadorDeErrores);
  return app;
}

let consoleErrorSpy;

beforeEach(() => {
  errorLogCreateMock.mockReset();
  errorLogCreateMock.mockResolvedValue({ id: 1 });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("manejadorDeErrores — enmascarado del 500", () => {
  // Esta es la razón por la que el handler se extrajo a su propio módulo: los
  // `buildApp()` de la suite montaban una versión que devolvía `err.message`
  // tal cual, así que un test podía pasar afirmando un cuerpo que producción
  // nunca manda.
  it("nunca filtra el mensaje real de un error sin status", async () => {
    const err = new Error("Invalid `prisma.product.findMany()` en dbo.Product");

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Error interno del servidor.");
    expect(res.text).not.toContain("prisma");
  });

  it("persiste el mensaje REAL en ErrorLog aunque el cliente vea el genérico", async () => {
    const err = new Error("connection pool timeout");

    await request(appQueLanza(err)).get("/boom");

    expect(errorLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        mensaje: "connection pool timeout",
        ruta: "/boom",
        metodo: "GET",
        status: 500,
      }),
    });
  });

  it("deja pasar el mensaje cuando el error trae un status propio", async () => {
    const err = new Error("El DNI es obligatorio.");
    err.status = 400;

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("El DNI es obligatorio.");
  });

  it("respeta un status de error no-500 como el 502 de Cloudinary", async () => {
    const err = new Error("La subida a Cloudinary falló (Request Timeout).");
    err.status = 502;

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("La subida a Cloudinary falló (Request Timeout).");
  });
});

describe("manejadorDeErrores — MulterError", () => {
  it("mapea LIMIT_FILE_SIZE a 413", async () => {
    const err = new multer.MulterError("LIMIT_FILE_SIZE", "video");

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("El archivo supera el tamaño máximo permitido.");
  });

  it("mapea LIMIT_UNEXPECTED_FILE en el campo fotos al tope de fotos", async () => {
    const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", "fotos");

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(400);
    // Atado a la constante, no al literal: si MAX_FOTOS cambia, el mensaje
    // tiene que acompañarlo (por eso los tres usos comparten
    // `lib/limitesMedios.js`).
    expect(res.body.error).toBe(`Se permiten máximo ${MAX_FOTOS} fotos por producto.`);
  });

  it("mapea LIMIT_UNEXPECTED_FILE en el campo video al tope de un video", async () => {
    const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", "video");

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Se permite máximo ${MAX_VIDEOS} video por producto.`);
  });

  it("mapea LIMIT_UNEXPECTED_FILE de un campo desconocido al mensaje genérico", async () => {
    const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", "adjunto");

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Campo de archivo inesperado.");
  });

  it("mapea cualquier otro código de multer a 400 genérico", async () => {
    const err = new multer.MulterError("LIMIT_PART_COUNT", "fotos");

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Error al procesar el archivo subido.");
  });

  it("registra el MulterError en ErrorLog con su status mapeado", async () => {
    const err = new multer.MulterError("LIMIT_FILE_SIZE", "video");

    await request(appQueLanza(err)).get("/boom");

    expect(errorLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 413 }),
    });
  });
});

describe("manejadorDeErrores — errores de Prisma", () => {
  it("mapea P2002 nombrando el campo cuando meta.target es un array", async () => {
    const err = new Error("Unique constraint failed");
    err.code = "P2002";
    err.meta = { target: ["sku"] };

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Ya existe un registro con ese sku.");
  });

  it("mapea P2002 cuando meta.target es un string suelto", async () => {
    const err = new Error("Unique constraint failed");
    err.code = "P2002";
    err.meta = { target: "email" };

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Ya existe un registro con ese email.");
  });

  it("mapea P2002 sin meta al texto genérico en vez de decir undefined", async () => {
    const err = new Error("Unique constraint failed");
    err.code = "P2002";

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Ya existe un registro con ese valor.");
  });

  it("mapea P2003 en un DELETE a 400 sugiriendo ocultar en vez de borrar", async () => {
    const err = new Error("Foreign key constraint failed");
    err.code = "P2003";

    const res = await request(appQueLanza(err)).delete("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "No se puede eliminar: otros registros dependen de este. Ocultalo en vez de borrarlo.",
    );
  });

  it("mapea P2003 fuera de un DELETE a 400 hablando de una referencia inválida, no de borrar", async () => {
    // La violación de FK también salta al INSERTAR (ej.: POST /api/eventos con
    // un productId inexistente). El status 400 era correcto pero el mensaje
    // hablaba de eliminar, que ahí es absurdo.
    const err = new Error("Foreign key constraint failed");
    err.code = "P2003";

    const res = await request(appQueLanza(err)).post("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Alguno de los datos hace referencia a un registro que no existe.");
  });

  it("mapea P2000 (valor más largo que la columna) a 400, nunca a un 500 opaco", async () => {
    const err = new Error("The provided value for the column is too long for the column's type.");
    err.code = "P2000";
    err.meta = { column_name: "referrer" };

    const res = await request(appQueLanza(err)).post("/boom");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Uno de los valores enviados es demasiado largo.");
  });

  it("no imprime en consola ni enmascara un P2000: es un error de cliente", async () => {
    const err = new Error("value too long");
    err.code = "P2000";

    const res = await request(appQueLanza(err)).post("/boom");

    expect(res.body.error).not.toBe("Error interno del servidor.");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("no enmascara los errores de Prisma mapeados: no son 500", async () => {
    const err = new Error("Unique constraint failed");
    err.code = "P2002";
    err.meta = { target: ["nombre"] };

    const res = await request(appQueLanza(err)).get("/boom");

    expect(res.body.error).not.toBe("Error interno del servidor.");
  });
});

describe("manejadorDeErrores — ruido en consola", () => {
  // Antes se imprimía el stack SIEMPRE, así que cada bot pegándole a una ruta
  // rara o cada formulario mal completado enterraba las fallas reales.
  it("no imprime nada en consola para un error de cliente", async () => {
    const err = new Error("El nombre es obligatorio.");
    err.status = 400;

    await request(appQueLanza(err)).get("/boom");

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("no imprime nada en consola para un MulterError", async () => {
    const err = new multer.MulterError("LIMIT_UNEXPECTED_FILE", "fotos");

    await request(appQueLanza(err)).get("/boom");

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("sí imprime el error cuando es un 500", async () => {
    const err = new Error("algo se rompió de verdad");

    await request(appQueLanza(err)).get("/boom");

    expect(consoleErrorSpy).toHaveBeenCalledWith(err);
  });
});

describe("manejadorDeErrores — propagación de la causa", () => {
  it("manda err.cause a logError para que llegue al ErrorLog", async () => {
    // Este es el caso real de `cloudinary.service.js`: el SDK rechaza con un
    // objeto plano y el service lo cuelga de `cause` para no perder el
    // `http_code`.
    const err = new Error("La subida a Cloudinary falló (Request Timeout).");
    err.status = 502;
    err.cause = { message: "Request Timeout", http_code: 499 };

    await request(appQueLanza(err)).get("/boom");

    const { stack } = errorLogCreateMock.mock.calls[0][0].data;
    expect(stack).toContain("http_code");
    expect(stack).toContain("499");
  });
});
