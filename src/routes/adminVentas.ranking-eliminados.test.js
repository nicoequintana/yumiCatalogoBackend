import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { Decimal } from "@prisma/client/runtime/client.js";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * Ranking de productos vendidos cuando el producto ya no existe.
 *
 * Desde que `ItemOrden.productId` es nullable con `onDelete: SetNull`, borrar
 * un producto deja sus líneas históricas con `productId: null` pero con el
 * snapshot `nombreProducto` intacto.
 *
 * **El modo de falla que estas pruebas existen para impedir:** agrupar por
 * `item.productId` a secas mete a TODOS los productos borrados en una sola
 * entrada del mapa (la clave `null`), sumando la facturación de productos
 * distintos bajo el nombre del primero que aparezca. No tira error, no avisa:
 * simplemente informa un número inventado. Por eso la clave del agrupamiento
 * cae al snapshot cuando no hay id.
 */

const ordenFindManyMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    errorLog: { findMany: vi.fn(), count: vi.fn() },
    auditLog: { findMany: vi.fn(), count: vi.fn() },
    orden: { findMany: (...args) => ordenFindManyMock(...args) },
  },
}));

const { default: adminRouter } = await import("./admin.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminRouter);
  app.use(manejadorDeErrores);
  return app;
}

const authHeader = `Bearer ${jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" })}`;

function item(productId, nombreProducto, precio, cantidad) {
  return { productId, nombreProducto, precioUnitario: new Decimal(precio), cantidad };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ranking de ventas con productos eliminados", () => {
  it("no fusiona dos productos borrados distintos en una sola fila", async () => {
    ordenFindManyMock.mockResolvedValue([
      {
        id: 1,
        estado: "ENTREGADA",
        createdAt: new Date(),
        items: [item(null, "Termo borrado", "100", 2), item(null, "Mate borrado", "50", 1)],
      },
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    const nombres = res.body.rankingProductos.map((p) => p.nombre).sort();
    expect(nombres).toEqual(["Mate borrado", "Termo borrado"]);
    // Cada uno con SU facturación, no la suma de los dos en una fila.
    const porNombre = Object.fromEntries(
      res.body.rankingProductos.map((p) => [p.nombre, p.facturacion]),
    );
    expect(porNombre["Termo borrado"]).toBe("200");
    expect(porNombre["Mate borrado"]).toBe("50");
  });

  it("acumula las lineas del MISMO producto borrado en una sola fila", async () => {
    ordenFindManyMock.mockResolvedValue([
      {
        id: 1,
        estado: "ENTREGADA",
        createdAt: new Date(),
        items: [item(null, "Termo borrado", "100", 2)],
      },
      {
        id: 2,
        estado: "ENTREGADA",
        createdAt: new Date(),
        items: [item(null, "Termo borrado", "100", 3)],
      },
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    expect(res.body.rankingProductos).toHaveLength(1);
    expect(res.body.rankingProductos[0]).toEqual(
      expect.objectContaining({ nombre: "Termo borrado", unidades: 5, facturacion: "500" }),
    );
  });

  it("emite productId null para el borrado, sin confundirlo con uno vivo", async () => {
    ordenFindManyMock.mockResolvedValue([
      {
        id: 1,
        estado: "ENTREGADA",
        createdAt: new Date(),
        items: [item(null, "Termo borrado", "100", 1), item(7, "Mate vivo", "100", 1)],
      },
    ]);

    const res = await request(buildApp()).get("/api/admin/ventas").set("Authorization", authHeader);

    const porNombre = Object.fromEntries(
      res.body.rankingProductos.map((p) => [p.nombre, p.productId]),
    );
    expect(porNombre["Termo borrado"]).toBeNull();
    expect(porNombre["Mate vivo"]).toBe(7);
  });
});
