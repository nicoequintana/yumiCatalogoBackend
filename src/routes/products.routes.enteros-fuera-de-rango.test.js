/**
 * `GET /api/products` con un número que NO se puede representar exacto.
 *
 * `?campania=1e21` respondía **500** con una fila en `ErrorLog`, en el listado
 * público. `Number("1e21")` es `1e21`, que pasa `Number.isInteger` y es
 * positivo, así que la guarda lo dejaba llegar a Prisma — y el query engine
 * corta con *"Unable to fit value 1e+21 into a 64-bit signed integer"*, un
 * error sin `status` que el handler global vuelve 500.
 *
 * El mismo agujero estaba en `?categoria=`, `?ids=`, `?minPrecio=`,
 * `?maxPrecio=` y `?page=`: los seis verificados con curl contra el backend
 * real, los seis con su fila en `ErrorLog`.
 *
 * ⚠️ **Con Prisma mockeado estos tests NO pueden fallar por el motivo real** —
 * el mock no valida rangos. Lo que fijan es la garantía que agrega la guarda:
 * el valor fuera de rango **no llega al `where`** y la base no se consulta con
 * él. Es la regla 3 del proyecto: la suite verde no alcanza, por eso el 500 se
 * verificó además con `curl`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const findManyMock = vi.fn();
const countMock = vi.fn();
const campaniaFindUniqueMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    promocionItem: { findMany: async () => [] },
    campania: { findUnique: (...args) => campaniaFindUniqueMock(...args) },
    product: {
      findMany: (...args) => findManyMock(...args),
      count: (...args) => countMock(...args),
    },
  },
}));
vi.mock("../services/cloudinary.service.js", () => ({}));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

/** El `where` con el que se pidió el listado. */
function whereDelListado() {
  return findManyMock.mock.calls[0][0].where;
}

beforeEach(() => {
  findManyMock.mockReset().mockResolvedValue([]);
  countMock.mockReset().mockResolvedValue(0);
  campaniaFindUniqueMock.mockReset();
});

describe("GET /api/products con enteros fuera del rango representable", () => {
  it("`?campania=1e21` responde 200 y NO consulta la campaña", async () => {
    const res = await request(buildApp()).get("/api/products?campania=1e21");

    expect(res.status).toBe(200);
    expect(campaniaFindUniqueMock).not.toHaveBeenCalled();
    // Se pidió una vitrina que no se puede resolver: la respuesta es VACÍA,
    // nunca el catálogo entero.
    expect(res.body.campania).toBe(null);
    expect(res.body.data).toEqual([]);
  });

  it("`?categoria=1e21` responde 200 sin mandar el valor al `where`", async () => {
    const res = await request(buildApp()).get("/api/products?categoria=1e21");

    expect(res.status).toBe(200);
    expect(whereDelListado().categoriaId).toBeUndefined();
  });

  it("`?ids=1e21` responde 200 y significa «ninguno», no «todo el catálogo»", async () => {
    const res = await request(buildApp()).get("/api/products?ids=1e21");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
    // El id se descarta como cualquier otro id inválido, así que la lista queda
    // vacía y entra en el cortocircuito de `listar`: ni siquiera se consulta.
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("`?minPrecio=1e21` y `?maxPrecio=1e21` responden 200 sin filtro de precio", async () => {
    const min = await request(buildApp()).get("/api/products?minPrecio=1e21");
    expect(min.status).toBe(200);
    expect(whereDelListado().precio).toBeUndefined();

    findManyMock.mockClear();
    const max = await request(buildApp()).get("/api/products?maxPrecio=1e21");
    expect(max.status).toBe(200);
    expect(whereDelListado().precio).toBeUndefined();
  });

  it("`?maxPrecio=9999999999.9` responde 200: no entra en `Decimal(10, 0)`", async () => {
    // El tope del filtro no es el de un entero de 64 bits sino el de la COLUMNA:
    // un decimal por encima de `Decimal(10, 0)` produce *"Arithmetic overflow
    // error converting nvarchar to data type numeric"*, también un 500.
    const res = await request(buildApp()).get("/api/products?maxPrecio=9999999999.9");

    expect(res.status).toBe(200);
    expect(whereDelListado().precio).toBeUndefined();
  });

  it("`?minPrecio=1500` sigue filtrando: la guarda es de rango, no de tipo", async () => {
    const res = await request(buildApp()).get("/api/products?minPrecio=1500");

    expect(res.status).toBe(200);
    expect(whereDelListado().precio).toEqual({ gte: 1500 });
  });

  it("`?page=1e21` responde 200 y pagina desde el principio", async () => {
    const res = await request(buildApp()).get("/api/products?page=1e21");

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(1);
    expect(findManyMock.mock.calls[0][0].skip).toBe(0);
  });

  it("`?campania=7` sigue resolviendo la vitrina: nada de esto rompe el camino feliz", async () => {
    const unDia = 24 * 60 * 60 * 1000;
    campaniaFindUniqueMock.mockResolvedValue({
      id: 7,
      nombre: "Primavera",
      estado: "HABILITADA",
      desde: new Date(Date.now() - unDia),
      hasta: new Date(),
    });

    const res = await request(buildApp()).get("/api/products?campania=7");

    expect(res.status).toBe(200);
    expect(campaniaFindUniqueMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } }),
    );
    expect(res.body.campania).toEqual({ id: 7, nombre: "Primavera" });
  });
});
