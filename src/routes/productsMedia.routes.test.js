import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { Readable } from "node:stream";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

/**
 * Proxy de streaming de la media legada de Google Drive
 * (`controllers/productsMedia.controller.js`).
 *
 * Es el único código del backend que devuelve bytes en vez de JSON, y el único
 * que negocia `Range`/206. Todo lo que se afirma acá describe lo que el
 * controller HACE hoy: si alguna de estas expectativas parece discutible, el
 * lugar para discutirla es el controller, no el test.
 *
 * Los servicios de storage están mockeados a propósito — la suite no toca la
 * red. Un `Readable` de `node:stream` alcanza para reproducir el
 * comportamiento de un stream de Drive, incluidos sus modos de falla.
 */

process.env.JWT_SECRET = "test-secret";

const productFindUniqueMock = vi.fn();
const fotoFindFirstMock = vi.fn();
const obtenerStreamVideoMock = vi.fn();
const obtenerStreamArchivoMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: { findUnique: (...args) => productFindUniqueMock(...args) },
    foto: { findFirst: (...args) => fotoFindFirstMock(...args) },
  },
}));
vi.mock("../services/googleDrive.service.js", () => ({
  obtenerStreamVideo: (...args) => obtenerStreamVideoMock(...args),
  obtenerStreamArchivo: (...args) => obtenerStreamArchivoMock(...args),
  eliminarArchivo: vi.fn(),
}));
vi.mock("../services/cloudinary.service.js", () => ({}));
// El logueo técnico es fire-and-forget contra `ErrorLog`; acá interesa QUE se
// registre la falla del stream, no que se persista.
vi.mock("../lib/logError.js", () => ({ logError: (...args) => logErrorMock(...args) }));

const { default: productsRouter } = await import("./products.routes.js");

/**
 * Última respuesta de Express que atendió una request.
 *
 * Es el único punto de observación fiable para las ramas que dependen de
 * `res.headersSent`: permite esperar a que las cabeceras ya hayan salido antes
 * de provocar el error, en vez de confiar en un `setTimeout` arbitrario.
 */
let ultimaRes = null;

function buildApp() {
  const app = express();
  app.use((_req, res, next) => {
    ultimaRes = res;
    next();
  });
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

/**
 * Cabeceras tal como las devuelve gaxios: una instancia de `Headers` de fetch,
 * NO un objeto plano. La diferencia es justamente la trampa que documenta el
 * controller y que verifica el test "lee las cabeceras con .get()".
 */
function cabecerasDrive(pares) {
  return new Headers(pares);
}

/** Stream que entrega `texto` completo y cierra. */
function streamDeTexto(texto) {
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from(texto));
  stream.push(null);
  return stream;
}

/** Stream que entrega un primer chunk y queda abierto hasta que lo destruyan. */
function streamAbierto(primerChunk) {
  const stream = new Readable({ read() {} });
  stream.push(Buffer.from(primerChunk));
  return stream;
}

/**
 * Stream que falla apenas alguien intenta leerlo, sin haber entregado un solo
 * byte. Destruir desde `_read` garantiza que el `error` se emita DESPUÉS de que
 * el controller haya enganchado su listener, sin depender de timers.
 */
function streamQueFallaAlLeer(mensaje) {
  return new Readable({
    read() {
      this.destroy(new Error(mensaje));
    },
  });
}

/**
 * Cuerpo de una respuesta binaria.
 *
 * superagent no le enchufa parser de texto a `video/*` ni a `image/*`: deja el
 * cuerpo como `Buffer` en `res.body` y `res.text` queda `undefined`. Hay que
 * pedirle además `.buffer()` para que lo acumule.
 */
function cuerpoDe(res) {
  return Buffer.isBuffer(res.body) ? res.body.toString() : (res.text ?? "");
}

/** Espera activa corta: evita `setTimeout` mágicos en los tests de streaming. */
async function esperarA(condicion, descripcion) {
  for (let intento = 0; intento < 400; intento += 1) {
    if (condicion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Se agotó la espera de: ${descripcion}`);
}

const CUERPO = "0123456789"; // 10 bytes exactos: el Content-Length tiene que coincidir.

beforeEach(() => {
  vi.clearAllMocks();
  ultimaRes = null;
});

describe("GET /api/products/:id/video — proxy de streaming", () => {
  const productoConVideoDrive = {
    id: 1,
    video: { id: 5, driveFileId: "drive-video-1", cloudinaryPublicId: null },
  };

  it("devuelve 200 con el cuerpo completo y las cabeceras que dio Drive", async () => {
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 200,
      headers: cabecerasDrive({ "content-type": "video/mp4", "content-length": String(CUERPO.length) }),
    });

    const res = await request(buildApp()).get("/api/products/1/video").buffer();

    expect(res.status).toBe(200);
    expect(cuerpoDe(res)).toBe(CUERPO);
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-length"]).toBe("10");
    // `Accept-Ranges` viaja incluso en la respuesta sin Range: es lo que le
    // avisa al `<video>` que puede pedir tramos para hacer seek.
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-range"]).toBeUndefined();
  });

  it("cae al MIME por defecto si Drive no informa content-type", async () => {
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 200,
      headers: cabecerasDrive({}),
    });

    const res = await request(buildApp()).get("/api/products/1/video");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("video/mp4");
    // Sin content-length de Drive tampoco se inventa uno.
    expect(res.headers["content-length"]).toBeUndefined();
  });

  it("lee las cabeceras de Drive con .get() y no por acceso de índice", async () => {
    // El objeto que devuelve gaxios NO tiene propiedades propias enumerables:
    // leerlo por índice da `undefined` y el bug pasa desapercibido porque el
    // controller cae a sus valores por defecto. Este test falla si alguien
    // "simplifica" los `.get(...)` a `headers["content-type"]`.
    const headers = cabecerasDrive({
      "content-type": "video/webm",
      "content-length": String(CUERPO.length),
    });
    expect(headers["content-type"]).toBeUndefined();
    expect(JSON.stringify(headers)).toBe("{}");

    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({ stream: streamDeTexto(CUERPO), status: 200, headers });

    const res = await request(buildApp()).get("/api/products/1/video");

    expect(res.headers["content-type"]).toBe("video/webm");
    expect(res.headers["content-length"]).toBe("10");
  });

  it("reenvía el Range a Drive y responde 206 con su Content-Range", async () => {
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 206,
      headers: cabecerasDrive({
        "content-type": "video/mp4",
        "content-range": "bytes 0-9/100",
        "content-length": String(CUERPO.length),
      }),
    });

    const res = await request(buildApp()).get("/api/products/1/video").set("Range", "bytes=0-9");

    expect(obtenerStreamVideoMock).toHaveBeenCalledWith("drive-video-1", "bytes=0-9");
    expect(res.status).toBe(206);
    expect(res.headers["content-range"]).toBe("bytes 0-9/100");
    expect(res.headers["content-length"]).toBe("10");
    expect(res.headers["accept-ranges"]).toBe("bytes");
  });

  it("no manda Range a Drive cuando el cliente no pidió ninguno", async () => {
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 200,
      headers: cabecerasDrive({ "content-type": "video/mp4" }),
    });

    await request(buildApp()).get("/api/products/1/video");

    expect(obtenerStreamVideoMock).toHaveBeenCalledWith("drive-video-1", undefined);
  });

  it("con un Range malformado no parsea nada: lo reenvía tal cual y espeja la respuesta de Drive", async () => {
    // El controller NO valida el Range: delega en Drive, que ante un rango
    // ininteligible devuelve 200 con el cuerpo entero. El cliente recibe ese
    // 200, no un 416.
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 200,
      headers: cabecerasDrive({ "content-type": "video/mp4", "content-length": String(CUERPO.length) }),
    });

    const res = await request(buildApp())
      .get("/api/products/1/video")
      .set("Range", "bytes=no-es-un-rango")
      .buffer();

    expect(obtenerStreamVideoMock).toHaveBeenCalledWith("drive-video-1", "bytes=no-es-un-rango");
    expect(res.status).toBe(200);
    expect(res.headers["content-range"]).toBeUndefined();
    expect(cuerpoDe(res)).toBe(CUERPO);
  });

  it("responde 200 si Drive devuelve 206 pero el cliente nunca pidió un Range", async () => {
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 206,
      headers: cabecerasDrive({ "content-type": "video/mp4", "content-range": "bytes 0-9/100" }),
    });

    const res = await request(buildApp()).get("/api/products/1/video");

    // Las tres condiciones del 206 son conjuntas: Range del cliente + 206 de
    // Drive + Content-Range presente. Falta una y se responde 200.
    expect(res.status).toBe(200);
    expect(res.headers["content-range"]).toBeUndefined();
  });

  it("responde 200 si Drive devuelve 206 sin Content-Range", async () => {
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 206,
      headers: cabecerasDrive({ "content-type": "video/mp4", "content-length": String(CUERPO.length) }),
    });

    const res = await request(buildApp()).get("/api/products/1/video").set("Range", "bytes=0-9");

    expect(res.status).toBe(200);
    expect(res.headers["content-range"]).toBeUndefined();
  });

  describe("404 — el video no se puede servir", () => {
    it("id no numérico", async () => {
      const res = await request(buildApp()).get("/api/products/abc/video");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Producto no encontrado.");
      // Ni siquiera se consulta la base con un id basura.
      expect(productFindUniqueMock).not.toHaveBeenCalled();
    });

    it("producto inexistente", async () => {
      productFindUniqueMock.mockResolvedValue(null);

      const res = await request(buildApp()).get("/api/products/1/video");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Producto no encontrado.");
      expect(obtenerStreamVideoMock).not.toHaveBeenCalled();
    });

    it("producto sin video", async () => {
      productFindUniqueMock.mockResolvedValue({ id: 1, video: null });

      const res = await request(buildApp()).get("/api/products/1/video");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Este producto no tiene video.");
    });

    it("video alojado en Cloudinary, no en Drive", async () => {
      // Bifurcación de storage: este proxy es SOLO para las filas legado. Un
      // video de Cloudinary se sirve por su propia URL (`mapProducto` ni
      // siquiera apunta acá), así que pedirlo por esta ruta es un 404.
      productFindUniqueMock.mockResolvedValue({
        id: 1,
        video: { id: 5, driveFileId: null, cloudinaryPublicId: "yima/1/video", url: "https://cdn.test/v.mp4" },
      });

      const res = await request(buildApp()).get("/api/products/1/video");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("El video de este producto no está disponible.");
      expect(obtenerStreamVideoMock).not.toHaveBeenCalled();
    });

    it("Drive responde 404 (archivo borrado a mano)", async () => {
      productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
      obtenerStreamVideoMock.mockRejectedValue(Object.assign(new Error("File not found"), { code: 404 }));

      const res = await request(buildApp()).get("/api/products/1/video");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("El video de este producto no está disponible.");
    });

    it("Drive responde 404 informándolo en response.status", async () => {
      // gaxios reserva `code` para errores de red (ENOTFOUND y compañía) y deja
      // el status HTTP en `response.status`: el controller acepta las dos formas.
      productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
      obtenerStreamVideoMock.mockRejectedValue(
        Object.assign(new Error("File not found"), { response: { status: 404 } }),
      );

      const res = await request(buildApp()).get("/api/products/1/video");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("El video de este producto no está disponible.");
    });
  });

  it("traduce cualquier otra falla de Drive a 502", async () => {
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockRejectedValue(Object.assign(new Error("boom"), { code: "ENOTFOUND" }));

    const res = await request(buildApp()).get("/api/products/1/video");

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("No se pudo obtener el video desde Google Drive.");
  });

  it("responde 502 en JSON si el stream falla ANTES de mandar cabeceras", async () => {
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({
      stream: streamQueFallaAlLeer("Drive cortó antes del primer byte"),
      status: 200,
      headers: cabecerasDrive({ "content-type": "video/mp4" }),
    });

    const res = await request(buildApp()).get("/api/products/1/video").buffer();

    expect(res.status).toBe(502);
    expect(JSON.parse(cuerpoDe(res))).toEqual({
      error: "No se pudo transmitir el video desde Google Drive.",
    });
    // COMPORTAMIENTO ACTUAL, NO DESEABLE: el Content-Type ya se fijó en
    // `video/mp4` antes de piper y `res.json()` de Express no pisa un
    // Content-Type ya seteado, así que este JSON de error viaja rotulado como
    // video (con `Accept-Ranges: bytes` colgado de arriba). El test describe lo
    // que el código HACE hoy; el arreglo se decide aparte.
    expect(res.headers["content-type"]).toMatch(/^video\/mp4/);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 502,
        ruta: "/api/products/1/video",
        metodo: "GET",
        mensaje: expect.stringContaining("Drive cortó antes del primer byte"),
      }),
    );
  });

  it("si el stream falla DESPUÉS de mandar cabeceras, corta la conexión sin responder dos veces", async () => {
    const stream = streamAbierto("primer-chunk");
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({
      stream,
      status: 200,
      headers: cabecerasDrive({ "content-type": "video/mp4" }),
    });

    const pendiente = request(buildApp())
      .get("/api/products/1/video")
      .then(
        (res) => ({ completo: true, res }),
        (err) => ({ completo: false, err }),
      );

    await esperarA(() => ultimaRes?.headersSent === true, "que salgan las cabeceras del 200");
    stream.destroy(new Error("Drive se cayó a mitad del video"));
    await pendiente;

    // La prueba de que NO se intentó una segunda respuesta: el status quedó en
    // el 200 ya enviado. `res.status(502)` habría mutado `statusCode` a 502
    // aunque las cabeceras ya hubieran salido.
    expect(ultimaRes.statusCode).toBe(200);
    await esperarA(() => ultimaRes.destroyed === true, "que se destruya la respuesta");
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 502,
        mensaje: expect.stringContaining("Drive se cayó a mitad del video"),
      }),
    );
  });

  it("destruye el stream de Drive si el cliente se desconecta a mitad de la descarga", async () => {
    const stream = streamAbierto("primer-chunk");
    productFindUniqueMock.mockResolvedValue(productoConVideoDrive);
    obtenerStreamVideoMock.mockResolvedValue({
      stream,
      status: 200,
      headers: cabecerasDrive({ "content-type": "video/mp4" }),
    });

    const pendiente = request(buildApp()).get("/api/products/1/video");
    pendiente.end(() => {}); // el abort hace fallar el callback: se ignora a propósito

    await esperarA(() => ultimaRes?.headersSent === true, "que salgan las cabeceras del 200");
    expect(stream.destroyed).toBe(false);

    pendiente.abort();

    // Sin esto el stream de Drive quedaría vivo por cada seek del reproductor.
    await esperarA(() => stream.destroyed === true, "que se aborte el stream de Drive");
  });
});

describe("GET /api/products/:id/fotos/:fotoId — proxy de streaming", () => {
  const fotoDrive = { id: 7, productId: 1, driveFileId: "drive-foto-7", cloudinaryPublicId: null };

  it("devuelve 200 con el cuerpo y las cabeceras que dio Drive", async () => {
    fotoFindFirstMock.mockResolvedValue(fotoDrive);
    obtenerStreamArchivoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 200,
      headers: cabecerasDrive({ "content-type": "image/png", "content-length": String(CUERPO.length) }),
    });

    const res = await request(buildApp()).get("/api/products/1/fotos/7");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-length"]).toBe("10");
    expect(obtenerStreamArchivoMock).toHaveBeenCalledWith("drive-foto-7");
  });

  it("cae al MIME por defecto si Drive no informa content-type", async () => {
    fotoFindFirstMock.mockResolvedValue(fotoDrive);
    obtenerStreamArchivoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 200,
      headers: cabecerasDrive({}),
    });

    const res = await request(buildApp()).get("/api/products/1/fotos/7");

    expect(res.headers["content-type"]).toBe("image/jpeg");
  });

  it("ignora el Range: una foto no es media seekeable", async () => {
    fotoFindFirstMock.mockResolvedValue(fotoDrive);
    obtenerStreamArchivoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 200,
      headers: cabecerasDrive({ "content-type": "image/png", "content-length": String(CUERPO.length) }),
    });

    const res = await request(buildApp())
      .get("/api/products/1/fotos/7")
      .set("Range", "bytes=0-4")
      .buffer();

    // Ni se reenvía a Drive, ni se anuncia soporte de rangos, ni hay 206.
    expect(obtenerStreamArchivoMock).toHaveBeenCalledWith("drive-foto-7");
    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBeUndefined();
    expect(res.headers["content-range"]).toBeUndefined();
    expect(cuerpoDe(res)).toBe(CUERPO);
  });

  it("busca la foto acotada a su producto, no por id suelto", async () => {
    fotoFindFirstMock.mockResolvedValue(fotoDrive);
    obtenerStreamArchivoMock.mockResolvedValue({
      stream: streamDeTexto(CUERPO),
      status: 200,
      headers: cabecerasDrive({ "content-type": "image/png" }),
    });

    await request(buildApp()).get("/api/products/1/fotos/7");

    expect(fotoFindFirstMock).toHaveBeenCalledWith({ where: { id: 7, productId: 1 } });
  });

  describe("404 — la foto no se puede servir", () => {
    it("id de producto no numérico", async () => {
      const res = await request(buildApp()).get("/api/products/abc/fotos/7");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Producto o foto no encontrados.");
      expect(fotoFindFirstMock).not.toHaveBeenCalled();
    });

    it("id de foto no numérico", async () => {
      const res = await request(buildApp()).get("/api/products/1/fotos/xyz");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Producto o foto no encontrados.");
      expect(fotoFindFirstMock).not.toHaveBeenCalled();
    });

    it("foto inexistente", async () => {
      fotoFindFirstMock.mockResolvedValue(null);

      const res = await request(buildApp()).get("/api/products/1/fotos/7");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Foto no encontrada.");
      expect(obtenerStreamArchivoMock).not.toHaveBeenCalled();
    });

    it("foto de OTRO producto: el filtro por productId la deja fuera", async () => {
      // El `findFirst` lleva `productId` en el where, así que pedir la foto 7
      // colgada del producto 99 no devuelve fila. Sin ese filtro, cualquiera
      // podría enumerar fotos ajenas cambiando el id del producto en la URL.
      fotoFindFirstMock.mockResolvedValue(null);

      const res = await request(buildApp()).get("/api/products/99/fotos/7");

      expect(fotoFindFirstMock).toHaveBeenCalledWith({ where: { id: 7, productId: 99 } });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Foto no encontrada.");
    });

    it("foto de placeholder o de Cloudinary (sin driveFileId)", async () => {
      fotoFindFirstMock.mockResolvedValue({
        id: 7,
        productId: 1,
        driveFileId: null,
        cloudinaryPublicId: "yima/1/foto",
      });

      const res = await request(buildApp()).get("/api/products/1/fotos/7");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Esta foto no está disponible.");
      expect(obtenerStreamArchivoMock).not.toHaveBeenCalled();
    });

    it("Drive responde 404", async () => {
      fotoFindFirstMock.mockResolvedValue(fotoDrive);
      obtenerStreamArchivoMock.mockRejectedValue(Object.assign(new Error("not found"), { code: 404 }));

      const res = await request(buildApp()).get("/api/products/1/fotos/7");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Esta foto no está disponible.");
    });
  });

  it("traduce cualquier otra falla de Drive a 502", async () => {
    fotoFindFirstMock.mockResolvedValue(fotoDrive);
    obtenerStreamArchivoMock.mockRejectedValue(Object.assign(new Error("boom"), { response: { status: 500 } }));

    const res = await request(buildApp()).get("/api/products/1/fotos/7");

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("No se pudo obtener la foto desde Google Drive.");
  });

  it("responde 502 en JSON si el stream falla ANTES de mandar cabeceras", async () => {
    fotoFindFirstMock.mockResolvedValue(fotoDrive);
    obtenerStreamArchivoMock.mockResolvedValue({
      stream: streamQueFallaAlLeer("Drive cortó antes del primer byte"),
      status: 200,
      headers: cabecerasDrive({ "content-type": "image/png" }),
    });

    const res = await request(buildApp()).get("/api/products/1/fotos/7").buffer();

    expect(res.status).toBe(502);
    expect(JSON.parse(cuerpoDe(res))).toEqual({
      error: "No se pudo transmitir la foto desde Google Drive.",
    });
    // Mismo comportamiento actual que en el video: el JSON de error sale con el
    // Content-Type de la imagen, porque ya estaba seteado cuando se llamó a
    // `res.json()`.
    expect(res.headers["content-type"]).toMatch(/^image\/png/);
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 502,
        ruta: "/api/products/1/fotos/7",
        metodo: "GET",
        mensaje: expect.stringContaining("Drive cortó antes del primer byte"),
      }),
    );
  });

  it("si el stream falla DESPUÉS de mandar cabeceras, corta la conexión sin responder dos veces", async () => {
    const stream = streamAbierto("primer-chunk");
    fotoFindFirstMock.mockResolvedValue(fotoDrive);
    obtenerStreamArchivoMock.mockResolvedValue({
      stream,
      status: 200,
      headers: cabecerasDrive({ "content-type": "image/png" }),
    });

    const pendiente = request(buildApp())
      .get("/api/products/1/fotos/7")
      .then(
        (res) => ({ completo: true, res }),
        (err) => ({ completo: false, err }),
      );

    await esperarA(() => ultimaRes?.headersSent === true, "que salgan las cabeceras del 200");
    stream.destroy(new Error("Drive se cayó a mitad de la foto"));
    await pendiente;

    expect(ultimaRes.statusCode).toBe(200);
    await esperarA(() => ultimaRes.destroyed === true, "que se destruya la respuesta");
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 502,
        mensaje: expect.stringContaining("Drive se cayó a mitad de la foto"),
      }),
    );
  });

  it("destruye el stream de Drive si el cliente se desconecta a mitad de la descarga", async () => {
    const stream = streamAbierto("primer-chunk");
    fotoFindFirstMock.mockResolvedValue(fotoDrive);
    obtenerStreamArchivoMock.mockResolvedValue({
      stream,
      status: 200,
      headers: cabecerasDrive({ "content-type": "image/png" }),
    });

    const pendiente = request(buildApp()).get("/api/products/1/fotos/7");
    pendiente.end(() => {});

    await esperarA(() => ultimaRes?.headersSent === true, "que salgan las cabeceras del 200");
    expect(stream.destroyed).toBe(false);

    pendiente.abort();

    await esperarA(() => stream.destroyed === true, "que se aborte el stream de Drive");
  });
});
