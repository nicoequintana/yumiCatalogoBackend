/**
 * `GET /api/campanias/vitrinas` — una sección de productos por campaña
 * ACTIVA, para la home pública (`Catalogo.jsx`).
 *
 * Reusa el contrato público de `GET /products?campania=ID`
 * (`products.routes.campania.test.js`): mismas guardas, mismo `select`, misma
 * resolución de descuento. Lo que estos tests fijan, y por qué:
 *
 * 1. **La vigencia la decide `resolverEstadoCampania`, no el `where`.** Una
 *    campaña HABILITADA pero vencida no puede seguir vidriereando.
 * 2. **Las guardas públicas COMPONEN con la vitrina.** Un producto oculto o
 *    agotado no puede aparecer, igual que en `?campania=`.
 * 3. **Nunca `costo`/`coeficiente`.** Este endpoint no tiene rama admin.
 * 4. **El descuento se resuelve** con la MISMA `resolverDescuentos`.
 * 5. **`MIN_PRODUCTOS_VITRINA_HOME` (4) se aplica ACÁ**, no en el frontend.
 * 6. **`MAX_PRODUCTOS_VITRINA_HOME` (8) topea cada vidriera.**
 * 7. **El orden es por `prioridad` descendente, desempate por `id` descendente.**
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

const campaniaFindManyMock = vi.fn();
const productFindManyMock = vi.fn();
const promocionItemFindManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    campania: { findMany: (...args) => campaniaFindManyMock(...args) },
    product: { findMany: (...args) => productFindManyMock(...args) },
    promocionItem: { findMany: (...args) => promocionItemFindManyMock(...args) },
  },
}));
vi.mock("../services/cloudinary.service.js", () => ({}));

const { default: campaniasRouter } = await import("./campanias.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/campanias", campaniasRouter);
  app.use(manejadorDeErrores);
  return app;
}

const UN_DIA = 24 * 60 * 60 * 1000;

function campania(extra = {}) {
  return {
    id: 1,
    nombre: "Primavera",
    estado: "HABILITADA",
    desde: new Date(Date.now() - UN_DIA),
    hasta: new Date(Date.now() + UN_DIA),
    prioridad: 0,
    ...extra,
  };
}

function producto(extra = {}) {
  return {
    id: 7,
    sku: "YIMA-0007",
    nombre: "Termo Stanley",
    precio: { toString: () => "48000" },
    costo: { toString: () => "20000" },
    coeficiente: { toString: () => "2" },
    etiqueta: null,
    visibleEnCatalogo: true,
    stock: 5,
    destacado: false,
    vistas: 0,
    compartidos: 0,
    categoria: null,
    fotos: [{ id: 11, url: "https://res.cloudinary.com/demo/termo.webp", orden: 0 }],
    _count: { fotos: 1 },
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    campanias: [{ campaniaId: 1 }],
    ...extra,
  };
}

/** `n` productos distintos, todos en la vitrina de `campaniaId`. */
function productos(n, campaniaId = 1, base = {}) {
  return Array.from({ length: n }, (_, i) =>
    producto({ id: 100 + i, sku: `YIMA-${100 + i}`, campanias: [{ campaniaId }], ...base }),
  );
}

beforeEach(() => {
  campaniaFindManyMock.mockReset().mockResolvedValue([]);
  productFindManyMock.mockReset().mockResolvedValue([]);
  promocionItemFindManyMock.mockReset().mockResolvedValue([]);
});

describe("GET /api/campanias/vitrinas", () => {
  it("sin ninguna campaña activa responde un array vacío, sin tocar productos", async () => {
    campaniaFindManyMock.mockResolvedValue([]);

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("una campaña HABILITADA pero VENCIDA no aporta vidriera", async () => {
    campaniaFindManyMock.mockResolvedValue([
      campania({ desde: new Date(Date.now() - 10 * UN_DIA), hasta: new Date(Date.now() - 2 * UN_DIA) }),
    ]);

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("una campaña DESHABILITADA no aporta vidriera aunque esté en fecha", async () => {
    campaniaFindManyMock.mockResolvedValue([campania({ estado: "DESHABILITADA" })]);

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(productFindManyMock).not.toHaveBeenCalled();
  });

  it("compone el `where` con las guardas públicas y la vitrina de las campañas activas", async () => {
    campaniaFindManyMock.mockResolvedValue([campania()]);
    productFindManyMock.mockResolvedValue(productos(4));

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    expect(res.status).toBe(200);
    const { where } = productFindManyMock.mock.calls[0][0];
    expect(where).toEqual({
      visibleEnCatalogo: true,
      stock: { gt: 0 },
      campanias: { some: { campaniaId: { in: [1] } } },
    });
  });

  it("con al menos 4 productos publicados, emite la campaña con su vitrina completa", async () => {
    campaniaFindManyMock.mockResolvedValue([campania()]);
    productFindManyMock.mockResolvedValue(productos(4));

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { campaniaId: 1, nombre: "Primavera", productos: expect.any(Array) },
    ]);
    expect(res.body[0].productos).toHaveLength(4);
  });

  it("con menos de MIN_PRODUCTOS_VITRINA_HOME (4) productos, la campaña se OMITE", async () => {
    campaniaFindManyMock.mockResolvedValue([campania()]);
    productFindManyMock.mockResolvedValue(productos(3));

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("topea cada vidriera en MAX_PRODUCTOS_VITRINA_HOME (8), aunque haya más publicados", async () => {
    campaniaFindManyMock.mockResolvedValue([campania()]);
    productFindManyMock.mockResolvedValue(productos(11));

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    expect(res.status).toBe(200);
    expect(res.body[0].productos).toHaveLength(8);
  });

  it("un producto oculto o agotado no puede aparecer en ninguna vidriera (guarda pública)", async () => {
    campaniaFindManyMock.mockResolvedValue([campania()]);
    // El mock no aplica el `where` de verdad — lo que blinda esto es que la
    // consulta real ya pide `visibleEnCatalogo: true, stock: { gt: 0 }` (test
    // de arriba). Acá se confirma que, si la base ya filtró, el mapeo no
    // vuelve a exponer nada fuera de esa guarda.
    productFindManyMock.mockResolvedValue(productos(4));

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    for (const p of res.body[0].productos) {
      expect(p.visibleEnCatalogo).toBe(true);
      expect(p.stock).toBeGreaterThan(0);
    }
  });

  it("nunca emite costo ni coeficiente, aunque el producto los tenga cargados", async () => {
    campaniaFindManyMock.mockResolvedValue([campania()]);
    productFindManyMock.mockResolvedValue(productos(4));

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    for (const p of res.body[0].productos) {
      expect(p).not.toHaveProperty("costo");
      expect(p).not.toHaveProperty("coeficiente");
    }
  });

  it("resuelve el descuento vigente de cada producto, mismo criterio que el listado público", async () => {
    campaniaFindManyMock.mockResolvedValue([campania()]);
    productFindManyMock.mockResolvedValue([producto({ id: 7, campanias: [{ campaniaId: 1 }] }), ...productos(3, 1)]);
    promocionItemFindManyMock.mockResolvedValue([
      { productId: 7, porcentaje: 10, promocion: { id: 5, nombre: "Liquidación" } },
    ]);

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    const conDescuento = res.body[0].productos.find((p) => p.id === 7);
    expect(conDescuento.precioEfectivo).toBe("43200");
    // Público: solo el porcentaje, nunca el nombre de la promoción.
    expect(conDescuento.descuento).toEqual({ porcentaje: 10 });
  });

  it("ordena las campañas por prioridad descendente, desempate por id descendente", async () => {
    campaniaFindManyMock.mockResolvedValue([
      campania({ id: 1, nombre: "Baja prioridad", prioridad: 0 }),
      campania({ id: 2, nombre: "Alta prioridad", prioridad: 10 }),
      campania({ id: 3, nombre: "Empate más nueva", prioridad: 10 }),
    ]);
    productFindManyMock.mockResolvedValue([
      ...productos(4, 1),
      ...productos(4, 2),
      ...productos(4, 3),
    ]);

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    expect(res.body.map((v) => v.campaniaId)).toEqual([3, 2, 1]);
  });

  it("un producto en la vitrina de dos campañas activas aparece en las dos", async () => {
    campaniaFindManyMock.mockResolvedValue([campania({ id: 1 }), campania({ id: 2 })]);
    const compartido = producto({ id: 7, campanias: [{ campaniaId: 1 }, { campaniaId: 2 }] });
    productFindManyMock.mockResolvedValue([compartido, ...productos(3, 1), ...productos(3, 2)]);

    const res = await request(buildApp()).get("/api/campanias/vitrinas");

    expect(res.body).toHaveLength(2);
    for (const vitrina of res.body) {
      expect(vitrina.productos.some((p) => p.id === 7)).toBe(true);
    }
  });
});
