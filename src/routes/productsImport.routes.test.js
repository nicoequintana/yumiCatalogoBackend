import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import ExcelJS from "exceljs";

process.env.JWT_SECRET = "test-secret";

const categoriaMock = { findMany: vi.fn() };
const productCreateMock = vi.fn();
const transactionMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    categoria: { findMany: (...args) => categoriaMock.findMany(...args) },
    product: { create: (...args) => productCreateMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    $transaction: (...args) => transactionMock(...args),
  },
}));

const { COLUMNAS } = await import("../lib/importProductos.js");
const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use("/api/products", productsRouter);
  app.use((err, _req, res, _next) => {
    // Espeja el handler real de `server.js`: en 500 el mensaje se reemplaza,
    // así un test no puede pasar afirmando un mensaje que en producción el
    // usuario nunca vería.
    const status = err.status ?? 500;
    res.status(status).json({ error: status === 500 ? "Error interno del servidor." : err.message });
  });
  return app;
}

async function xlsxCon(filas) {
  const wb = new ExcelJS.Workbook();
  const hoja = wb.addWorksheet("Productos");
  hoja.addRow(COLUMNAS);
  for (const fila of filas) hoja.addRow(COLUMNAS.map((c) => fila[c] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test" }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
  categoriaMock.findMany.mockResolvedValue([{ id: 7, nombre: "Velas" }]);
  // `$transaction` recibe un array de promesas de create; devolvemos lo que
  // esas promesas resuelvan, igual que hace Prisma.
  transactionMock.mockImplementation((operaciones) => Promise.all(operaciones));
});

describe("GET /api/products/import/template", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/products/import/template");

    expect(res.status).toBe(401);
  });

  it("devuelve un .xlsx con las categorías actuales, sin caché", async () => {
    const res = await request(buildApp())
      .get("/api/products/import/template")
      .set("Authorization", authHeader)
      .responseType("blob");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toContain("plantilla-productos.xlsx");
    expect(res.headers["cache-control"]).toBe("no-store");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.getWorksheet("Listas").getCell("A2").value).toBe("Velas");
  });

  it("NO matchea contra la ruta /:id — el orden de las rutas importa", async () => {
    const res = await request(buildApp())
      .get("/api/products/import/template")
      .set("Authorization", authHeader);

    // Si matcheara /:id, el controller de detalle respondería 404 o 500.
    expect(res.status).toBe(200);
  });
});

describe("POST /api/products/import", () => {
  it("responde 401 sin token y no escribe nada", async () => {
    const res = await request(buildApp())
      .post("/api/products/import")
      .attach("archivo", await xlsxCon([{ nombre: "A", descripcion: "d", precio: 1 }]), "p.xlsx");

    expect(res.status).toBe(401);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("responde 400 si no se adjuntó ningún archivo", async () => {
    const res = await request(buildApp())
      .post("/api/products/import")
      .set("Authorization", authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(".xlsx");
  });

  it("importa los productos, todos ocultos, y responde 201", async () => {
    productCreateMock.mockImplementation(({ data }) =>
      Promise.resolve({ ...data, id: 1, precio: data.precio, fotos: [], caracteristicas: [], listas: [], especificaciones: [] }),
    );

    const res = await request(buildApp())
      .post("/api/products/import")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxCon([
          { nombre: "Vela", descripcion: "Lavanda", precio: 1500, categoria: "Velas" },
          { nombre: "Difusor", descripcion: "Cítrico", precio: 2000 },
        ]),
        "p.xlsx",
      );

    expect(res.status).toBe(201);
    expect(res.body.cantidad).toBe(2);
    expect(productCreateMock).toHaveBeenCalledTimes(2);
    for (const llamada of productCreateMock.mock.calls) {
      expect(llamada[0].data.visibleEnCatalogo).toBe(false);
    }
    expect(productCreateMock.mock.calls[0][0].data.categoriaId).toBe(7);
  });

  it("ATOMICIDAD: una fila inválida entre varias no crea NINGÚN producto", async () => {
    const res = await request(buildApp())
      .post("/api/products/import")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxCon([
          { nombre: "Vela", descripcion: "Lavanda", precio: 1500 },
          { nombre: "", descripcion: "x", precio: 100 },
          { nombre: "Difusor", descripcion: "x", precio: 2000 },
        ]),
        "p.xlsx",
      );

    expect(res.status).toBe(400);
    expect(productCreateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(res.body.errores).toEqual([
      { fila: 3, columna: "nombre", valor: "", motivo: "El nombre es obligatorio." },
    ]);
  });

  it("devuelve los errores de TODAS las filas malas, con fila y columna", async () => {
    const res = await request(buildApp())
      .post("/api/products/import")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxCon([
          { nombre: "A", descripcion: "d", precio: "abc" },
          { nombre: "B", descripcion: "d", precio: 100, categoria: "Bazr" },
        ]),
        "p.xlsx",
      );

    expect(res.status).toBe(400);
    expect(res.body.errores).toHaveLength(2);
    expect(res.body.errores.map((e) => [e.fila, e.columna])).toEqual([
      [2, "precio"],
      [3, "categoria"],
    ]);
  });

  it("rechaza un archivo que no es .xlsx con 400 y mensaje util", async () => {
    const res = await request(buildApp())
      .post("/api/products/import")
      .set("Authorization", authHeader)
      .attach("archivo", Buffer.from("nombre,precio"), "productos.csv");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(".xlsx");
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("genera SKU unicos aunque muchas filas compartan el mismo nombre", async () => {
    productCreateMock.mockImplementation(({ data }) =>
      Promise.resolve({ ...data, id: 1, fotos: [], caracteristicas: [], listas: [], especificaciones: [] }),
    );

    const filas = Array.from({ length: 20 }, () => ({ nombre: "Vela", descripcion: "d", precio: 100 }));

    const res = await request(buildApp())
      .post("/api/products/import")
      .set("Authorization", authHeader)
      .attach("archivo", await xlsxCon(filas), "p.xlsx");

    expect(res.status).toBe(201);
    const skus = productCreateMock.mock.calls.map((c) => c[0].data.sku);
    expect(skus).toHaveLength(20);
    expect(new Set(skus).size).toBe(skus.length);
  });

  it("REGRESION: fuerza colisiones de sufijo random y verifica que igual salgan SKU unicos", async () => {
    // Sin este fix, `generarSku` se llama una vez por fila sin reintento: si
    // `Math.random` repite el mismo sufijo (como acá, a propósito), dos filas
    // del mismo lote terminan con el SKU idéntico.
    productCreateMock.mockImplementation(({ data }) =>
      Promise.resolve({ ...data, id: 1, fotos: [], caracteristicas: [], listas: [], especificaciones: [] }),
    );

    const secuencia = [0.1, 0.1, 0.1, 0.9]; // 3 colisiones seguidas, la 4ta libera
    let indice = 0;
    const randomSpy = vi.spyOn(Math, "random").mockImplementation(() => {
      const valor = secuencia[Math.min(indice, secuencia.length - 1)];
      indice += 1;
      return valor;
    });

    try {
      const filas = [
        { nombre: "Vela", descripcion: "d", precio: 100 },
        { nombre: "Vela", descripcion: "d", precio: 100 },
      ];

      const res = await request(buildApp())
        .post("/api/products/import")
        .set("Authorization", authHeader)
        .attach("archivo", await xlsxCon(filas), "p.xlsx");

      expect(res.status).toBe(201);
      const skus = productCreateMock.mock.calls.map((c) => c[0].data.sku);
      expect(skus[0]).not.toBe(skus[1]);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("audita la importación con la cantidad", async () => {
    productCreateMock.mockImplementation(({ data }) =>
      Promise.resolve({ ...data, id: 1, fotos: [], caracteristicas: [], listas: [], especificaciones: [] }),
    );

    await request(buildApp())
      .post("/api/products/import")
      .set("Authorization", authHeader)
      .attach("archivo", await xlsxCon([{ nombre: "Vela", descripcion: "d", precio: 1500 }]), "p.xlsx");

    // `logAudit` es fire-and-forget: se espera un tick para que corra.
    await new Promise((resolve) => setImmediate(resolve));

    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accion: "IMPORTAR", entidad: "Producto" }),
      }),
    );
  });
});
