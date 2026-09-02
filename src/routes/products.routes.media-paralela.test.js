import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * Estas pruebas cubren la paralelización del I/O de red contra Cloudinary /
 * Drive: la subida de fotos al crear o editar un producto, y la limpieza de
 * archivos al quitar fotos o borrar el producto.
 *
 * Lo que se verifica NO es "que sea más rápido" (sería un test de reloj,
 * inestable): se verifica el comportamiento observable que la paralelización
 * pone en riesgo y que debe seguir intacto —
 *
 *  1. El orden de `fotosSubidas` sigue siendo el orden de entrada, aunque las
 *     subidas terminen en otro orden. La posición es contenido (foto 0 =
 *     portada, foto 1 = "¿qué problema resuelve?"), no presentación.
 *  2. El contrato anti-huérfanos: si una subida falla, TODAS las que sí
 *     terminaron bien se borran de Cloudinary — incluidas las que terminan
 *     DESPUÉS del fallo, que con el bucle secuencial anterior ni siquiera
 *     llegaban a arrancar.
 *  3. La carpeta del producto se borra recién cuando ya no queda ningún
 *     archivo adentro (la Admin API de Cloudinary solo borra carpetas vacías).
 */

const updateMock = vi.fn();
const findUniqueMock = vi.fn();
const findUniqueOrThrowMock = vi.fn();
const fotoUpdateMock = vi.fn();
const fotoCreateManyMock = vi.fn();
const fotoDeleteManyMock = vi.fn();
const productDeleteMock = vi.fn();
const itemOrdenCountMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    // `requireAuth` lee la fila del usuario para verificar la revocación de
    // sesión Y el permiso de borrado (`puedeEliminar`). Sin este mock la
    // consulta lanza y el middleware de borrado niega por fail-closed.
    usuario: { findUnique: vi.fn().mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true }) },
    product: {
      create: vi.fn(),
      update: (...args) => updateMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      findMany: vi.fn(),
      findUniqueOrThrow: (...args) => findUniqueOrThrowMock(...args),
      delete: (...args) => productDeleteMock(...args),
    },
    itemOrden: { count: (...args) => itemOrdenCountMock(...args) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    errorLog: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    $transaction: async (fn) =>
      fn({
        product: {
          update: (...args) => updateMock(...args),
          findUniqueOrThrow: (...args) => findUniqueOrThrowMock(...args),
        },
        caracteristica: { deleteMany: vi.fn(), createMany: vi.fn() },
        foto: {
          deleteMany: (...args) => fotoDeleteManyMock(...args),
          update: (...args) => fotoUpdateMock(...args),
          createMany: (...args) => fotoCreateManyMock(...args),
        },
        video: { update: vi.fn(), create: vi.fn(), delete: vi.fn() },
        productoLista: { deleteMany: vi.fn(), createMany: vi.fn() },
        especificacion: { deleteMany: vi.fn(), createMany: vi.fn() },
      }),
  },
}));

/**
 * Registro de concurrencia compartido por los mocks: cada operación anota
 * cuántas hay en vuelo al arrancar, y el pico queda para las aserciones.
 */
function crearMedidor() {
  return { enVuelo: 0, pico: 0, eventos: [] };
}

let medidorSubidas = crearMedidor();
let medidorBorrados = crearMedidor();

/**
 * Plan de la subida por nombre de archivo: cuántos ticks tarda y si falla.
 * El nombre viaja en el propio buffer del archivo adjunto, así que el mock
 * sabe exactamente cuál de las fotos de entrada está procesando.
 */
let planSubidas = {};

/** Cede el control del event loop `ticks` veces. Determinista, sin timers. */
async function esperarTicks(ticks) {
  for (let i = 0; i < ticks; i += 1) await Promise.resolve();
}

// Firmas reales que exige la validación de magic bytes (`validarArchivos`). El
// identificador de cada archivo (`foto-0`, `video-0`) viaja DESPUÉS de la firma,
// así que el mock lo extrae por regex ignorando los bytes binarios de cabecera.
const FIRMA_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const FIRMA_MP4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
const fotoBuffer = (id) => Buffer.concat([FIRMA_JPEG, Buffer.from(id)]);
const videoBuffer = (id) => Buffer.concat([FIRMA_MP4, Buffer.from(id)]);

const subirArchivoMock = vi.fn(async (buffer, resourceType) => {
  // El identificador va después de la firma binaria; se lo extrae por patrón.
  const nombre = buffer.toString("latin1").match(/(?:foto|video)-\d+/)?.[0] ?? buffer.toString();
  const plan = planSubidas[nombre] ?? {};

  medidorSubidas.enVuelo += 1;
  medidorSubidas.pico = Math.max(medidorSubidas.pico, medidorSubidas.enVuelo);
  medidorSubidas.eventos.push(`inicia:${nombre}`);
  try {
    await esperarTicks(plan.ticks ?? 1);
    if (plan.falla) {
      const err = new Error(`La subida a Cloudinary falló (${nombre})`);
      err.status = 502;
      throw err;
    }
    medidorSubidas.eventos.push(`termina:${nombre}`);
    return {
      cloudinaryPublicId: `pub-${nombre}`,
      cloudinaryResourceType: resourceType,
      url: `https://cdn.test/${nombre}.jpg`,
    };
  } finally {
    medidorSubidas.enVuelo -= 1;
  }
});

const eliminarArchivoMock = vi.fn(async (publicId) => {
  medidorBorrados.enVuelo += 1;
  medidorBorrados.pico = Math.max(medidorBorrados.pico, medidorBorrados.enVuelo);
  medidorBorrados.eventos.push(`borra:${publicId}`);
  await esperarTicks(2);
  medidorBorrados.enVuelo -= 1;
});

const eliminarCarpetaMock = vi.fn(async (folder) => {
  medidorBorrados.eventos.push(`carpeta:${folder}`);
});

vi.mock("../services/cloudinary.service.js", () => ({
  subirArchivo: (...args) => subirArchivoMock(...args),
  eliminarArchivo: (...args) => eliminarArchivoMock(...args),
  eliminarCarpeta: (...args) => eliminarCarpetaMock(...args),
}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

const productoBase = {
  id: 42,
  nombre: "Lámpara",
  sku: "YIMA-LAMPAR-1234",
  precio: "100",
  etiqueta: null,
  categoria: null,
  caracteristicas: [],
  video: null,
  vistas: 0,
  compartidos: 0,
  favoritosCount: 0,
  visibleEnCatalogo: true,
  stock: 10,
  destacado: false,
  orden: 0,
  listas: [],
  especificaciones: [],
  fotos: [],
  driveFolderId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  medidorSubidas = crearMedidor();
  medidorBorrados = crearMedidor();
  planSubidas = {};
  findUniqueMock.mockResolvedValue(productoBase);
  findUniqueOrThrowMock.mockResolvedValue(productoBase);
  updateMock.mockResolvedValue(productoBase);
  itemOrdenCountMock.mockResolvedValue(0);
  productDeleteMock.mockResolvedValue({ id: 42 });
});

/** Adjunta N fotos cuyo contenido es su propio identificador (`foto-0`, ...). */
function adjuntarFotos(peticion, cantidad) {
  for (let i = 0; i < cantidad; i += 1) {
    peticion.attach("fotos", fotoBuffer(`foto-${i}`), {
      filename: `foto-${i}.jpg`,
      contentType: "image/jpeg",
    });
  }
  return peticion;
}

describe("PUT /api/products/:id — subida de fotos en paralelo", () => {
  it("arranca todas las subidas a la vez en lugar de una por una", async () => {
    await adjuntarFotos(
      request(buildApp())
        .put("/api/products/42")
        .set("Authorization", authHeader)
        .field("nombre", "Lámpara")
        .field("fotosExistentes", JSON.stringify([])),
      3,
    ).expect(200);

    expect(subirArchivoMock).toHaveBeenCalledTimes(3);
    expect(medidorSubidas.pico).toBe(3);
  });

  it("conserva el orden de entrada aunque las subidas terminen al revés", async () => {
    // La portada es la que más tarda: con `push` desde callbacks quedaría
    // última, y la ficha pública mostraría de portada la foto equivocada.
    planSubidas = {
      "foto-0": { ticks: 6 },
      "foto-1": { ticks: 3 },
      "foto-2": { ticks: 1 },
    };

    await adjuntarFotos(
      request(buildApp())
        .put("/api/products/42")
        .set("Authorization", authHeader)
        .field("nombre", "Lámpara")
        .field("fotosExistentes", JSON.stringify([])),
      3,
    ).expect(200);

    // Las subidas efectivamente terminaron en orden inverso al de entrada.
    expect(medidorSubidas.eventos.filter((e) => e.startsWith("termina:"))).toEqual([
      "termina:foto-2",
      "termina:foto-1",
      "termina:foto-0",
    ]);

    const creadas = fotoCreateManyMock.mock.calls[0][0].data;
    expect(creadas.map((f) => f.url)).toEqual([
      "https://cdn.test/foto-0.jpg",
      "https://cdn.test/foto-1.jpg",
      "https://cdn.test/foto-2.jpg",
    ]);
    expect(creadas.map((f) => f.orden)).toEqual([0, 1, 2]);
  });

  it("respeta `ordenFotos` mapeando cada índice a la foto que le corresponde", async () => {
    planSubidas = { "foto-0": { ticks: 5 }, "foto-1": { ticks: 1 } };

    await adjuntarFotos(
      request(buildApp())
        .put("/api/products/42")
        .set("Authorization", authHeader)
        .field("nombre", "Lámpara")
        .field("fotosExistentes", JSON.stringify([]))
        .field(
          "ordenFotos",
          JSON.stringify([
            { tipo: "nueva", index: 1 },
            { tipo: "nueva", index: 0 },
          ]),
        ),
      2,
    ).expect(200);

    const creadas = fotoCreateManyMock.mock.calls[0][0].data;
    expect(creadas).toEqual([
      expect.objectContaining({ url: "https://cdn.test/foto-1.jpg", orden: 0 }),
      expect.objectContaining({ url: "https://cdn.test/foto-0.jpg", orden: 1 }),
    ]);
  });

  it("limpia TODA subida exitosa cuando otra falla, incluidas las que terminan después del fallo", async () => {
    // El fallo llega antes que el éxito de foto-2 a propósito: es el caso que
    // el bucle secuencial no podía dejar huérfano (nunca arrancaba foto-2) y
    // que `Promise.all` sí dejaría huérfano (corta en el primer rechazo
    // mientras foto-2 sigue en vuelo). Por eso la implementación espera a que
    // TODAS se asienten antes de limpiar.
    planSubidas = {
      "foto-0": { ticks: 1 },
      "foto-1": { ticks: 2, falla: true },
      "foto-2": { ticks: 8 },
    };

    const res = await adjuntarFotos(
      request(buildApp())
        .put("/api/products/42")
        .set("Authorization", authHeader)
        .field("nombre", "Lámpara")
        .field("fotosExistentes", JSON.stringify([])),
      3,
    );

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/foto-1/);

    const borradas = eliminarArchivoMock.mock.calls.map(([publicId]) => publicId).sort();
    expect(borradas).toEqual(["pub-foto-0", "pub-foto-2"]);
    // Nada quedó a medio camino: ninguna subida seguía en vuelo al limpiar.
    expect(medidorSubidas.enVuelo).toBe(0);
    expect(fotoCreateManyMock).not.toHaveBeenCalled();
  });

  it("también limpia el video cuando la que falla es una foto", async () => {
    planSubidas = { "foto-0": { ticks: 1, falla: true }, "video-0": { ticks: 6 } };

    const res = await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Lámpara")
      .field("fotosExistentes", JSON.stringify([]))
      .attach("fotos", fotoBuffer("foto-0"), { filename: "foto-0.jpg", contentType: "image/jpeg" })
      .attach("video", videoBuffer("video-0"), { filename: "clip.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(502);
    expect(eliminarArchivoMock.mock.calls.map(([publicId]) => publicId)).toEqual(["pub-video-0"]);
  });

  it("no limpia nada cuando todas las subidas salen bien", async () => {
    await adjuntarFotos(
      request(buildApp())
        .put("/api/products/42")
        .set("Authorization", authHeader)
        .field("nombre", "Lámpara")
        .field("fotosExistentes", JSON.stringify([])),
      2,
    ).expect(200);

    expect(eliminarArchivoMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/products/:id — limpieza de media en paralelo", () => {
  const productoConMedia = {
    ...productoBase,
    fotos: [
      { id: 10, orden: 0, url: "u10", cloudinaryPublicId: "c10", cloudinaryResourceType: "image", driveFileId: null },
      { id: 11, orden: 1, url: "u11", cloudinaryPublicId: "c11", cloudinaryResourceType: "image", driveFileId: null },
      { id: 12, orden: 2, url: "u12", cloudinaryPublicId: "c12", cloudinaryResourceType: "image", driveFileId: null },
    ],
    video: { id: 5, url: "v", cloudinaryPublicId: "cv", cloudinaryResourceType: "video", driveFileId: null },
  };

  it("borra fotos y video a la vez, no uno detrás de otro", async () => {
    findUniqueMock.mockResolvedValue(productoConMedia);

    await request(buildApp()).delete("/api/products/42").set("Authorization", authHeader).expect(200);

    expect(eliminarArchivoMock).toHaveBeenCalledTimes(4);
    expect(medidorBorrados.pico).toBe(4);
  });

  it("borra la carpeta del producto recién cuando ya no queda ningún archivo adentro", async () => {
    // `delete_folder` de la Admin API solo funciona sobre una carpeta vacía:
    // adelantarla al paralelizar dejaría la carpeta viva para siempre.
    findUniqueMock.mockResolvedValue(productoConMedia);

    await request(buildApp()).delete("/api/products/42").set("Authorization", authHeader).expect(200);

    const indiceCarpeta = medidorBorrados.eventos.findIndex((e) => e.startsWith("carpeta:"));
    const ultimoBorrado = medidorBorrados.eventos.reduce(
      (ultimo, evento, indice) => (evento.startsWith("borra:") ? indice : ultimo),
      -1,
    );
    expect(indiceCarpeta).toBeGreaterThan(ultimoBorrado);
    expect(medidorBorrados.enVuelo).toBe(0);
  });
});

describe("PUT /api/products/:id — limpieza de fotos removidas en paralelo", () => {
  it("borra en paralelo las fotos que el admin sacó del producto", async () => {
    const conFotos = {
      ...productoBase,
      fotos: [
        { id: 10, orden: 0, url: "u10", cloudinaryPublicId: "c10", cloudinaryResourceType: "image", driveFileId: null },
        { id: 11, orden: 1, url: "u11", cloudinaryPublicId: "c11", cloudinaryResourceType: "image", driveFileId: null },
        { id: 12, orden: 2, url: "u12", cloudinaryPublicId: "c12", cloudinaryResourceType: "image", driveFileId: null },
      ],
    };
    findUniqueMock.mockResolvedValue(conFotos);
    findUniqueOrThrowMock.mockResolvedValue(conFotos);

    await request(buildApp())
      .put("/api/products/42")
      .set("Authorization", authHeader)
      .field("nombre", "Lámpara")
      .field("fotosExistentes", JSON.stringify([]))
      .expect(200);

    expect(eliminarArchivoMock.mock.calls.map(([publicId]) => publicId).sort()).toEqual(["c10", "c11", "c12"]);
    expect(medidorBorrados.pico).toBe(3);
  });
});
