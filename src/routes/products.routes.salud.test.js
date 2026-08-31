import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * `GET /api/products/salud` — el estado del catálogo, producto por producto,
 * en conteos.
 *
 * Contesta "qué de mi catálogo está frenando la venta", que es una pregunta
 * distinta de las de analytics: no mira tráfico ni plata, mira COMPLETITUD y
 * EXPOSICIÓN. Por eso sirve desde el día uno, cuando todavía no hay volumen
 * para que una tasa de conversión signifique algo.
 *
 * Lo que fijan estas suites:
 *
 *   1. **Todos los conteos van en la respuesta, también los que dan 0.** Un
 *      cero ES la información ("no tenés productos sin fotos"). Omitir la
 *      clave obligaría a la pantalla a distinguir "cero" de "no vino", que es
 *      justo la ambigüedad que este endpoint viene a eliminar.
 *   2. **Son conteos GLOBALES**, sin filtro ni paginación: la pregunta es
 *      "cuánto catálogo tengo así", no "cuánto entró en esta tabla".
 *   3. **La ruta va antes de `/:id`**, o Express matchea "salud" como un id.
 */

const countMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: { count: (...args) => countMock(...args) },
    usuario: { findUnique: vi.fn().mockResolvedValue({ id: 1, tokenVersion: 0 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    eventoTrafico: { create: vi.fn().mockResolvedValue({ id: 1 }) },
  },
}));
vi.mock("../services/googleDrive.service.js", () => ({ eliminarArchivo: vi.fn() }));
vi.mock("../services/cloudinary.service.js", () => ({ eliminarCarpeta: vi.fn() }));
vi.mock("../services/productoMedia.service.js", () => ({
  limpiarArchivosSubidos: vi.fn(),
  limpiarMediaRemota: vi.fn(),
  logFallaDeLimpieza: vi.fn(),
  sanitizarNombreParaCarpeta: (n) => n,
  subirArchivosNuevos: vi.fn(),
}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

function conAuth(peticion) {
  const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
    expiresIn: "7d",
  });
  return peticion.set("Authorization", `Bearer ${token}`);
}

/** Devuelve un número distinto por llamada, para que un conteo cruzado se note. */
function contarEnOrden(...valores) {
  let i = 0;
  countMock.mockImplementation(() => Promise.resolve(valores[i++] ?? 0));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/products/salud", () => {
  it("exige autenticación: los conteos incluyen productos ocultos", async () => {
    const res = await request(buildApp()).get("/api/products/salud");
    expect(res.status).toBe(401);
    expect(countMock).not.toHaveBeenCalled();
  });

  it("devuelve todas las claves, incluidas las que dan cero", async () => {
    countMock.mockResolvedValue(0);

    const res = await conAuth(request(buildApp()).get("/api/products/salud"));

    expect(res.status).toBe(200);
    for (const clave of [
      "total",
      "publicados",
      "ocultos",
      "agotados",
      "agotadosConVistas",
      "sinFotos",
      "publicadosSinFotos",
      "menosDeDosFotos",
      "sinCategoria",
      "sinCosto",
      "sinVistas",
      "publicadosSinVistas",
      "destacadosPublicados",
    ]) {
      expect(res.body, `falta la clave ${clave}`).toHaveProperty(clave, 0);
    }
  });

  it("cuenta en la base y no trae filas: nada de findMany", async () => {
    countMock.mockResolvedValue(3);
    const { prisma } = await import("../lib/prisma.js");
    expect(prisma.product.findMany).toBeUndefined();

    await conAuth(request(buildApp()).get("/api/products/salud"));

    // Un conteo por métrica, todos en paralelo. Si alguien lo reescribe
    // trayendo el catálogo entero a memoria, este test lo frena.
    expect(countMock.mock.calls.length).toBeGreaterThanOrEqual(13);
  });

  /*
   * Los `where` son el contrato real de este endpoint: si uno se escribe mal,
   * el número sale plausible y equivocado, que es el peor resultado posible en
   * una pantalla que existe para decidir en qué producto trabajar.
   */
  it("un producto publicado es visible Y con stock, no solo visible", async () => {
    countMock.mockResolvedValue(0);
    await conAuth(request(buildApp()).get("/api/products/salud"));

    const wheres = countMock.mock.calls.map((c) => JSON.stringify(c[0]?.where ?? {}));
    expect(wheres).toContain(JSON.stringify({ visibleEnCatalogo: true, stock: { gt: 0 } }));
  });

  it("cuenta los productos sin ninguna foto con una relación vacía", async () => {
    countMock.mockResolvedValue(0);
    await conAuth(request(buildApp()).get("/api/products/salud"));

    const wheres = countMock.mock.calls.map((c) => JSON.stringify(c[0]?.where ?? {}));
    expect(wheres).toContain(JSON.stringify({ fotos: { none: {} } }));
  });

  // `Foto.orden` es una secuencia compacta desde 0 (invariante documentada en
  // CLAUDE.md y sostenida por `MediaUploader`), así que "no tiene una foto en
  // la posición 1" es exactamente "tiene menos de dos fotos". Si esa invariante
  // se rompe, este conteo miente en silencio — de ahí el test explícito.
  it("deriva 'menos de dos fotos' de la ausencia de la posición 1", async () => {
    countMock.mockResolvedValue(0);
    await conAuth(request(buildApp()).get("/api/products/salud"));

    const wheres = countMock.mock.calls.map((c) => JSON.stringify(c[0]?.where ?? {}));
    expect(wheres).toContain(JSON.stringify({ fotos: { none: { orden: 1 } } }));
  });

  it("un producto sin costo es el que no tiene costo O no tiene coeficiente", async () => {
    countMock.mockResolvedValue(0);
    await conAuth(request(buildApp()).get("/api/products/salud"));

    const wheres = countMock.mock.calls.map((c) => JSON.stringify(c[0]?.where ?? {}));
    expect(wheres).toContain(JSON.stringify({ OR: [{ costo: null }, { coeficiente: null }] }));
  });

  it("emite los conteos que le corresponden a cada clave", async () => {
    // El orden del array es el orden del `Promise.all` del controller.
    contarEnOrden(80, 77, 3, 2, 1, 5, 4, 9, 6, 7, 23, 20, 0);

    const res = await conAuth(request(buildApp()).get("/api/products/salud"));

    expect(res.body.total).toBe(80);
    expect(res.body.publicados).toBe(77);
    expect(res.body.destacadosPublicados).toBe(0);
  });
});
