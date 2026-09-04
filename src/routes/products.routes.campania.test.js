/**
 * `GET /api/products?campania=ID` — la VITRINA de una campaña.
 *
 * Es lo que consume el botón del cartel estacional (`/coleccion?campania=ID`,
 * ver `resolverDestinoCta` en `campanias.controller.js`).
 *
 * Lo que estos tests fijan, y por qué:
 *
 * 1. **La vigencia la decide `resolverEstadoCampania`, no el `where`.** Meter
 *    `campania: { estado: "HABILITADA" }` dentro del `where` de productos
 *    ignoraría las FECHAS: una campaña habilitada pero vencida seguiría
 *    listando su vitrina mientras la pantalla dice que terminó. El caso
 *    "HABILITADA pero vencida" es el que justifica la decisión.
 * 2. **La vitrina COMPONE con las guardas públicas.** Un producto oculto o
 *    agotado no puede aparecer por estar en la vitrina, igual que con `ids`.
 * 3. **`campania` es la primera clave ADITIVA del sobre.** Solo viaja cuando el
 *    parámetro vino; sin él el sobre sigue teniendo exactamente cuatro claves.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

// La vista admin la habilita el JWT verificado, nunca `?admin=1`.
const authHeader = `Bearer ${jwt.sign({ sub: 1, tokenVersion: 0 }, "test-secret", { expiresIn: "7d" })}`;

const findManyMock = vi.fn();
const countMock = vi.fn();
const campaniaFindUniqueMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    // Sin promociones vigentes, que es el caso normal. `resolverDescuentos`
    // igual consulta, así que el mock tiene que existir.
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

const UN_DIA = 24 * 60 * 60 * 1000;

/**
 * Una campaña con el período centrado en hoy. `hasta` en el instante actual
 * alcanza porque el fin es EXCLUSIVO y vale hasta la medianoche siguiente.
 */
function campaniaVigente(extra = {}) {
  return {
    id: 7,
    nombre: "Primavera",
    estado: "HABILITADA",
    desde: new Date(Date.now() - UN_DIA),
    hasta: new Date(),
    ...extra,
  };
}

beforeEach(() => {
  findManyMock.mockReset();
  countMock.mockReset().mockResolvedValue(0);
  campaniaFindUniqueMock.mockReset();
});

describe("GET /api/products?campania=ID - vitrina de campaña", () => {
  it("compone el `some` con las guardas públicas y emite la campaña en el sobre", async () => {
    campaniaFindUniqueMock.mockResolvedValue(campaniaVigente());
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/products?campania=7");

    expect(res.status).toBe(200);
    const { where } = findManyMock.mock.calls[0][0];
    // Las guardas públicas siguen ahí: un producto oculto o agotado de la
    // vitrina NO puede aparecer.
    expect(where).toEqual({
      visibleEnCatalogo: true,
      stock: { gt: 0 },
      campanias: { some: { campaniaId: 7 } },
    });
    // Lo mínimo para que la pantalla pueda titular la vitrina. Nada más: es un
    // endpoint público.
    expect(res.body.campania).toEqual({ id: 7, nombre: "Primavera" });
  });

  it("en la vista admin filtra por la vitrina sin las guardas públicas", async () => {
    campaniaFindUniqueMock.mockResolvedValue(campaniaVigente());
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/products?campania=7")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toEqual({ campanias: { some: { campaniaId: 7 } } });
  });

  it("el count recibe el MISMO where que el findMany (si no, el total miente)", async () => {
    campaniaFindUniqueMock.mockResolvedValue(campaniaVigente());
    findManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products?campania=7");

    const { where } = findManyMock.mock.calls[0][0];
    expect(where).toMatchObject({ campanias: { some: { campaniaId: 7 } } });
    expect(countMock.mock.calls[0][0].where).toEqual(where);
  });

  it("una campaña DESHABILITADA devuelve la vitrina vacía sin tocar la tabla de productos", async () => {
    campaniaFindUniqueMock.mockResolvedValue(campaniaVigente({ estado: "DESHABILITADA" }));

    const res = await request(buildApp()).get("/api/products?campania=7");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], page: 1, pageSize: 12, total: 0, campania: null });
    // Vacío, NO el catálogo entero: la pantalla necesita distinguir "esta
    // vitrina no tiene nada" de "no hay catálogo".
    expect(findManyMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
  });

  it("una campaña HABILITADA pero VENCIDA también devuelve vacío", async () => {
    // El caso que un `where` con `estado: 'HABILITADA'` dejaría pasar: la
    // vigencia son DOS ejes, y este `where` solo miraría uno.
    campaniaFindUniqueMock.mockResolvedValue(
      campaniaVigente({ desde: new Date(Date.now() - 10 * UN_DIA), hasta: new Date(Date.now() - 2 * UN_DIA) }),
    );

    const res = await request(buildApp()).get("/api/products?campania=7");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], page: 1, pageSize: 12, total: 0, campania: null });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("una campaña inexistente devuelve vacío, no el catálogo entero", async () => {
    campaniaFindUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/products?campania=999");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], page: 1, pageSize: 12, total: 0, campania: null });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("un id que no es entero devuelve vacío sin consultar la campaña", async () => {
    const res = await request(buildApp()).get("/api/products?campania=abc");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [], page: 1, pageSize: 12, total: 0, campania: null });
    expect(campaniaFindUniqueMock).not.toHaveBeenCalled();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("sin el parámetro el sobre conserva exactamente sus cuatro claves", async () => {
    findManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/products");

    // `campania` es una clave ADITIVA: sin el parámetro no aparece, ni siquiera
    // como `undefined`.
    expect(Object.keys(res.body).sort()).toEqual(["data", "page", "pageSize", "total"]);
    expect(campaniaFindUniqueMock).not.toHaveBeenCalled();
  });
});
