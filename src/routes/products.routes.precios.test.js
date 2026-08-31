import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { Decimal } from "@prisma/client/runtime/client.js";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * `POST /api/products/precios-masivo` — aplicar el precio calculado
 * (`costo × coeficiente`, redondeado al peso) a varios
 * productos de una vez.
 *
 * Lo que estas suites fijan:
 *
 *   1. **El precio se ESCRIBE, no se deriva.** Es lo que hace que cambiar un
 *      costo no mueva el precio publicado hasta que alguien lo aplique.
 *   2. **Un producto sin costo se RECHAZA con motivo, no se saltea.** Aplicar
 *      sobre 40 y recibir "listo" habiendo tocado 31 es una mentira.
 *   3. **Un producto que ya está al día no se reescribe**, para que la
 *      auditoría no se llene de cambios que no cambiaron nada.
 *   4. **Un `AuditLog` por producto**, con precio anterior y nuevo: la pregunta
 *      que se le hace después al log es "¿quién le cambió el precio a ESTE?".
 */

const findManyMock = vi.fn();
const updateMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: {
      findMany: (...args) => findManyMock(...args),
      update: (...args) => updateMock(...args),
      count: vi.fn().mockResolvedValue(0),
    },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    usuario: { findUnique: vi.fn().mockResolvedValue({ id: 1, tokenVersion: 0 }) },
    eventoTrafico: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    $transaction: async (fn) => fn({ product: { update: (...args) => updateMock(...args) } }),
  },
}));
vi.mock("../services/googleDrive.service.js", () => ({
  eliminarArchivo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/cloudinary.service.js", () => ({
  eliminarCarpeta: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/productoMedia.service.js", () => ({
  limpiarArchivosSubidos: vi.fn().mockResolvedValue(undefined),
  limpiarMediaRemota: vi.fn().mockResolvedValue(undefined),
  logFallaDeLimpieza: vi.fn(),
  sanitizarNombreParaCarpeta: (nombre) => nombre,
  subirArchivosNuevos: vi.fn().mockResolvedValue({ fotos: [], video: null }),
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

function producto({ id, nombre = `Producto ${id}`, precio, costo, coeficiente }) {
  return {
    id,
    nombre,
    sku: `YIMA-TEST-${id}`,
    precio: new Decimal(precio),
    costo: costo === null ? null : new Decimal(costo),
    coeficiente: coeficiente === null ? null : new Decimal(coeficiente),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockResolvedValue({});
  auditCreateMock.mockResolvedValue({});
});

describe("POST /api/products/precios-masivo", () => {
  it("exige autenticación", async () => {
    const res = await request(buildApp()).post("/api/products/precios-masivo").send({ ids: [1] });
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("escribe el precio calculado de cada producto", async () => {
    findManyMock.mockResolvedValue([
      producto({ id: 1, precio: "18900", costo: "10000", coeficiente: "2.05" }),
      producto({ id: 2, precio: "29800", costo: "15200", coeficiente: "2.05" }),
    ]);

    const res = await conAuth(
      request(buildApp()).post("/api/products/precios-masivo").send({ ids: [1, 2] }),
    );

    expect(res.status).toBe(200);
    expect(res.body.actualizados).toBe(2);
    expect(res.body.resultados).toEqual([
      { id: 1, nombre: "Producto 1", precioAnterior: "18900", precioNuevo: "20500", cambio: true },
      { id: 2, nombre: "Producto 2", precioAnterior: "29800", precioNuevo: "31160", cambio: true },
    ]);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, data: expect.objectContaining({ precio: "20500" }) }),
    );
  });

  it("un coeficiente en el body pisa el de cada producto y queda guardado", async () => {
    findManyMock.mockResolvedValue([producto({ id: 1, precio: "20500", costo: "10000", coeficiente: "2.05" })]);

    const res = await conAuth(
      request(buildApp()).post("/api/products/precios-masivo").send({ ids: [1], coeficiente: "3" }),
    );

    expect(res.status).toBe(200);
    expect(res.body.resultados[0].precioNuevo).toBe("30000");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: { precio: "30000", coeficiente: "3" } }),
    );
  });

  // Sin costo no hay cuenta que hacer. Saltearlo en silencio haría que
  // "apliqué a 40" y "se tocaron 31" fueran indistinguibles.
  it("rechaza con motivo un producto sin costo, sin frenar a los demás", async () => {
    findManyMock.mockResolvedValue([
      producto({ id: 1, precio: "18900", costo: "10000", coeficiente: "2.05" }),
      producto({ id: 2, precio: "12000", costo: null, coeficiente: null }),
    ]);

    const res = await conAuth(
      request(buildApp()).post("/api/products/precios-masivo").send({ ids: [1, 2] }),
    );

    expect(res.status).toBe(200);
    expect(res.body.actualizados).toBe(1);
    expect(res.body.rechazados).toEqual([
      { id: 2, nombre: "Producto 2", motivo: "No tiene costo y coeficiente cargados." },
    ]);
  });

  it("rechaza un id inexistente en vez de omitirlo del informe", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await conAuth(
      request(buildApp()).post("/api/products/precios-masivo").send({ ids: [99] }),
    );

    expect(res.body.rechazados).toEqual([{ id: 99, nombre: null, motivo: "El producto no existe." }]);
    expect(res.body.actualizados).toBe(0);
  });

  it("no reescribe un producto que ya está al día", async () => {
    findManyMock.mockResolvedValue([producto({ id: 1, precio: "20500", costo: "10000", coeficiente: "2.05" })]);

    const res = await conAuth(
      request(buildApp()).post("/api/products/precios-masivo").send({ ids: [1] }),
    );

    expect(res.body.actualizados).toBe(0);
    expect(res.body.resultados[0]).toEqual({
      id: 1,
      nombre: "Producto 1",
      precioAnterior: "20500",
      precioNuevo: "20500",
      cambio: false,
    });
    expect(updateMock).not.toHaveBeenCalled();
    expect(auditCreateMock).not.toHaveBeenCalled();
  });

  it("deja un AuditLog por producto con el precio anterior y el nuevo", async () => {
    findManyMock.mockResolvedValue([producto({ id: 7, precio: "18900", costo: "10000", coeficiente: "2.05" })]);

    await conAuth(request(buildApp()).post("/api/products/precios-masivo").send({ ids: [7] }));

    expect(auditCreateMock).toHaveBeenCalledTimes(1);
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accion: "APLICAR_PRECIO",
          entidad: "Producto",
          entidadId: 7,
          detalle: expect.stringContaining("18900"),
        }),
      }),
    );
  });

  it("rechaza una selección vacía", async () => {
    const res = await conAuth(
      request(buildApp()).post("/api/products/precios-masivo").send({ ids: [] }),
    );
    expect(res.status).toBe(400);
  });

  it("rechaza pasarse del tope de ids en vez de truncar", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const res = await conAuth(
      request(buildApp()).post("/api/products/precios-masivo").send({ ids }),
    );
    expect(res.status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("rechaza un coeficiente inválido antes de tocar nada", async () => {
    const res = await conAuth(
      request(buildApp()).post("/api/products/precios-masivo").send({ ids: [1], coeficiente: "0" }),
    );
    expect(res.status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  // La ruta va declarada ANTES de `POST /:id/...`. Si alguien la mueve debajo,
  // Express matchea "precios-masivo" como un id y este test se cae.
  it("no la traga ninguna ruta `/:id`", async () => {
    findManyMock.mockResolvedValue([]);
    const res = await conAuth(
      request(buildApp()).post("/api/products/precios-masivo").send({ ids: [1] }),
    );
    expect(res.status).toBe(200);
  });
});

/**
 * `PATCH /api/products/:id/costeo` — guardar costo y coeficiente desde la tabla.
 *
 * Lo que fija esta suite, y es la invariante central de la feature: **guardar
 * un costo NO mueve el precio publicado**. Si algún día este endpoint escribe
 * `precio`, el catálogo empieza a cambiar de precio solo y el paso de
 * aprobación deja de existir.
 */
describe("PATCH /api/products/:id/costeo", () => {
  const findUniqueMock = vi.fn();

  beforeEach(() => {
    findUniqueMock.mockResolvedValue(
      producto({ id: 5, precio: "18900", costo: null, coeficiente: null }),
    );
    updateMock.mockResolvedValue({
      ...producto({ id: 5, precio: "18900", costo: "10000", coeficiente: "2.05" }),
      caracteristicas: [],
      listas: [],
      especificaciones: [],
      fotos: [],
      video: null,
      categoria: null,
    });
  });

  it("exige autenticación", async () => {
    const res = await request(buildApp()).patch("/api/products/5/costeo").send({ costo: "10000" });
    expect(res.status).toBe(401);
  });

  it("guarda costo y coeficiente sin tocar el precio", async () => {
    const { prisma } = await import("../lib/prisma.js");
    prisma.product.findUnique = findUniqueMock;

    const res = await conAuth(
      request(buildApp()).patch("/api/products/5/costeo").send({ costo: "10000", coeficiente: "2,05" }),
    );

    expect(res.status).toBe(200);
    const data = updateMock.mock.calls.at(-1)[0].data;
    expect(data).toEqual({ costo: "10000", coeficiente: "2.05" });
    expect(data).not.toHaveProperty("precio");
  });

  it("devuelve el producto con el cálculo y el estado resueltos", async () => {
    const { prisma } = await import("../lib/prisma.js");
    prisma.product.findUnique = findUniqueMock;

    const res = await conAuth(
      request(buildApp()).patch("/api/products/5/costeo").send({ costo: "10000", coeficiente: "2.05" }),
    );

    expect(res.body.precioCalculado).toBe("20500");
    expect(res.body.estadoPrecio).toBe("DIFIERE");
  });

  /**
   * Hasta el 31/08/2026 un valor vacío BORRABA la columna, y era correcto: el
   * costo era opcional y un dato cargado por error tenía que poder sacarse.
   *
   * Desde que el precio de venta se deriva de `costo × coeficiente`, borrarlo
   * deja al producto sin forma de recalcular su propio precio — el catálogo
   * seguiría mostrando el último número aplicado, ya sin nada que lo explique.
   * Por eso ahora es un 400. Omitir el campo sigue permitido: esta pantalla
   * guarda celda por celda y manda uno solo de los dos por vez.
   */
  it("rechaza vaciar la columna, pero sigue aceptando que se omita", async () => {
    const { prisma } = await import("../lib/prisma.js");
    prisma.product.findUnique = findUniqueMock;

    const res = await conAuth(
      request(buildApp()).patch("/api/products/5/costeo").send({ costo: "" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/costo.*no se puede borrar/i);

    // Solo el coeficiente: el costo no viaja y su columna queda intacta.
    updateMock.mockClear();
    await conAuth(request(buildApp()).patch("/api/products/5/costeo").send({ coeficiente: "2.5" }));
    expect(updateMock.mock.calls.at(-1)[0].data.costo).toBeUndefined();
  });

  it("rechaza un body sin ninguno de los dos campos", async () => {
    const res = await conAuth(request(buildApp()).patch("/api/products/5/costeo").send({}));
    expect(res.status).toBe(400);
  });
});
