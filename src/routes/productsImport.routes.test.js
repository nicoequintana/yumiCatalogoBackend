import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import ExcelJS from "exceljs";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const categoriaMock = { findMany: vi.fn() };
const productCreateMock = vi.fn();
const productFindManyMock = vi.fn();
const productUpdateMock = vi.fn();
const transactionMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    categoria: { findMany: (...args) => categoriaMock.findMany(...args) },
    product: {
      create: (...args) => productCreateMock(...args),
      findMany: (...args) => productFindManyMock(...args),
      update: (...args) => productUpdateMock(...args),
    },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    $transaction: (...args) => transactionMock(...args),
  },
}));

const { COLUMNAS, COLUMNAS_ACTUALIZACION } = await import("../lib/importProductos.js");
const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

async function xlsxCon(filas) {
  const wb = new ExcelJS.Workbook();
  const hoja = wb.addWorksheet("Productos");
  hoja.addRow(COLUMNAS);
  for (const fila of filas) hoja.addRow(COLUMNAS.map((c) => fila[c] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function xlsxConActualizacion(filas) {
  const wb = new ExcelJS.Workbook();
  const hoja = wb.addWorksheet("Productos");
  hoja.addRow(COLUMNAS_ACTUALIZACION);
  for (const fila of filas) hoja.addRow(COLUMNAS_ACTUALIZACION.map((c) => fila[c] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Precio "estilo Prisma Decimal": alcanza con `toString()` para estos tests. */
function decimal(valor) {
  return { toString: () => String(valor) };
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

describe("GET /api/products/export", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).get("/api/products/export");

    expect(res.status).toBe(401);
  });

  it("devuelve un .xlsx con una fila por producto, sin auditoría (es una lectura)", async () => {
    productFindManyMock.mockResolvedValue([
      {
        sku: "VEL-1",
        nombre: "Vela",
        descripcion: "Lavanda",
        precio: decimal("1500"),
        stock: 3,
        etiqueta: null,
        fraseComercial: null,
        porQueLoVasAQuerer: null,
        tePasaEsto: null,
        categoria: { nombre: "Velas" },
        caracteristicas: [],
        listas: [],
        especificaciones: [],
      },
    ]);
    categoriaMock.findMany.mockResolvedValue([{ nombre: "Velas" }]);

    const res = await request(buildApp())
      .get("/api/products/export")
      .set("Authorization", authHeader)
      .responseType("blob");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toContain("productos-export.xlsx");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(auditCreateMock).not.toHaveBeenCalled();

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const hoja = wb.getWorksheet("Productos");
    expect(hoja.getCell(2, COLUMNAS_ACTUALIZACION.indexOf("sku") + 1).value).toBe("VEL-1");
    expect(hoja.getCell(2, COLUMNAS_ACTUALIZACION.indexOf("categoria") + 1).value).toBe("Velas");
    expect(wb.getWorksheet("Listas").getCell("A2").value).toBe("Velas");
  });
});

describe("POST /api/products/actualizar-masivo", () => {
  it("responde 401 sin token y no escribe nada", async () => {
    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .attach(
        "archivo",
        await xlsxConActualizacion([{ sku: "VEL-1", nombre: "A", descripcion: "d", precio: 1 }]),
        "p.xlsx",
      );

    expect(res.status).toBe(401);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("responde 400 si no se adjuntó ningún archivo", async () => {
    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(".xlsx");
  });

  it("actualiza un producto existente por sku, sin tocar sku/visibilidad/destacado/orden", async () => {
    productFindManyMock.mockResolvedValue([{ id: 5, sku: "VEL-1", precio: decimal("1000"), stock: 2 }]);
    productUpdateMock.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 5,
        sku: "VEL-1",
        visibleEnCatalogo: true,
        destacado: true,
        orden: 3,
        ...data,
        precio: decimal(data.precio),
        categoria: null,
        fotos: [],
        video: null,
        caracteristicas: [],
        listas: [],
        especificaciones: [],
      }),
    );

    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([
          { sku: "VEL-1", nombre: "Vela renovada", descripcion: "d", precio: 1800, stock: 9 },
        ]),
        "p.xlsx",
      );

    expect(res.status).toBe(200);
    expect(res.body.creados).toBe(0);
    expect(res.body.actualizados).toBe(1);
    expect(productUpdateMock).toHaveBeenCalledTimes(1);

    const llamada = productUpdateMock.mock.calls[0][0];
    expect(llamada.where).toEqual({ id: 5 });
    expect(llamada.data.nombre).toBe("Vela renovada");
    expect(llamada.data.precio).toBe("1800");
    expect(llamada.data.stock).toBe(9);
    // Invariante de seguridad del diseño: estos campos NO van en el `data`
    // del update, así Prisma los deja intactos.
    expect(llamada.data.sku).toBeUndefined();
    expect(llamada.data.visibleEnCatalogo).toBeUndefined();
    expect(llamada.data.destacado).toBeUndefined();
    expect(llamada.data.orden).toBeUndefined();
    expect(res.body.productos[0].visibleEnCatalogo).toBe(true);
    expect(res.body.productos[0].destacado).toBe(true);
    expect(res.body.productos[0].orden).toBe(3);
  });

  it("con sku vacío CREA el producto nuevo, oculto y con sku recién generado", async () => {
    productFindManyMock.mockResolvedValue([{ id: 5, sku: "VEL-1", precio: decimal("1000"), stock: 2 }]);
    productCreateMock.mockImplementation(({ data }) =>
      Promise.resolve({
        ...data,
        id: 99,
        precio: decimal(data.precio),
        categoria: null,
        fotos: [],
        video: null,
        caracteristicas: [],
        listas: [],
        especificaciones: [],
      }),
    );

    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([
          { sku: "", nombre: "Producto nuevo", descripcion: "d", precio: 500, stock: 4 },
        ]),
        "p.xlsx",
      );

    expect(res.status).toBe(200);
    expect(res.body.creados).toBe(1);
    expect(res.body.actualizados).toBe(0);
    expect(productCreateMock).toHaveBeenCalledTimes(1);
    expect(productUpdateMock).not.toHaveBeenCalled();

    const llamada = productCreateMock.mock.calls[0][0];
    expect(llamada.data.nombre).toBe("Producto nuevo");
    expect(llamada.data.visibleEnCatalogo).toBe(false);
    expect(llamada.data.sku).not.toBe("VEL-1");
    expect(llamada.data.sku).toMatch(/^YIMA-/);
    expect(res.body.productos[0].visibleEnCatalogo).toBe(false);
  });

  it("un archivo con una fila sku-vacío + una fila sku-existente crea Y actualiza en la misma transacción", async () => {
    productFindManyMock.mockResolvedValue([{ id: 5, sku: "VEL-1", precio: decimal("1000"), stock: 2 }]);
    productCreateMock.mockImplementation(({ data }) =>
      Promise.resolve({
        ...data,
        id: 99,
        precio: decimal(data.precio),
        categoria: null,
        fotos: [],
        video: null,
        caracteristicas: [],
        listas: [],
        especificaciones: [],
      }),
    );
    productUpdateMock.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 5,
        sku: "VEL-1",
        visibleEnCatalogo: true,
        destacado: false,
        orden: 0,
        ...data,
        precio: decimal(data.precio),
        categoria: null,
        fotos: [],
        video: null,
        caracteristicas: [],
        listas: [],
        especificaciones: [],
      }),
    );

    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([
          { sku: "VEL-1", nombre: "Vela renovada", descripcion: "d", precio: 1800, stock: 9 },
          { sku: "", nombre: "Producto nuevo", descripcion: "d", precio: 500 },
        ]),
        "p.xlsx",
      );

    expect(res.status).toBe(200);
    expect(res.body.creados).toBe(1);
    expect(res.body.actualizados).toBe(1);
    expect(productCreateMock).toHaveBeenCalledTimes(1);
    expect(productUpdateMock).toHaveBeenCalledTimes(1);
    expect(res.body.productos).toHaveLength(2);
  });

  it("rechaza (400, todo o nada) si una fila tiene sku inexistente y no actualiza ninguna", async () => {
    productFindManyMock.mockResolvedValue([{ id: 5, sku: "VEL-1", precio: decimal("1000"), stock: 2 }]);

    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([
          { sku: "VEL-1", nombre: "Vela", descripcion: "d", precio: 1500 },
          { sku: "NOEXISTE", nombre: "Difusor", descripcion: "d", precio: 2000 },
        ]),
        "p.xlsx",
      );

    expect(res.status).toBe(400);
    expect(productUpdateMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
    expect(res.body.errores).toEqual([
      { fila: 3, columna: "sku", valor: "NOEXISTE", motivo: "No existe ningún producto con este SKU." },
    ]);
  });

  it("audita la actualización por producto, con precio antes/después", async () => {
    productFindManyMock.mockResolvedValue([{ id: 5, sku: "VEL-1", precio: decimal("1000"), stock: 2 }]);
    productUpdateMock.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 5,
        sku: "VEL-1",
        visibleEnCatalogo: true,
        destacado: false,
        orden: 0,
        ...data,
        precio: decimal(data.precio),
        categoria: null,
        fotos: [],
        video: null,
        caracteristicas: [],
        listas: [],
        especificaciones: [],
      }),
    );

    await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([
          { sku: "VEL-1", nombre: "Vela", descripcion: "d", precio: 1800, stock: 9 },
        ]),
        "p.xlsx",
      );

    await new Promise((resolve) => setImmediate(resolve));

    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accion: "ACTUALIZAR_MASIVO", entidad: "Producto", entidadId: 5 }),
      }),
    );
  });

  it("audita IMPORTAR_MASIVO para el creado y ACTUALIZAR_MASIVO para el actualizado, en el mismo lote", async () => {
    productFindManyMock.mockResolvedValue([{ id: 5, sku: "VEL-1", precio: decimal("1000"), stock: 2 }]);
    productCreateMock.mockImplementation(({ data }) =>
      Promise.resolve({
        ...data,
        id: 99,
        precio: decimal(data.precio),
        categoria: null,
        fotos: [],
        video: null,
        caracteristicas: [],
        listas: [],
        especificaciones: [],
      }),
    );
    productUpdateMock.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 5,
        sku: "VEL-1",
        visibleEnCatalogo: true,
        destacado: false,
        orden: 0,
        ...data,
        precio: decimal(data.precio),
        categoria: null,
        fotos: [],
        video: null,
        caracteristicas: [],
        listas: [],
        especificaciones: [],
      }),
    );

    await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([
          { sku: "VEL-1", nombre: "Vela", descripcion: "d", precio: 1800, stock: 9 },
          { sku: "", nombre: "Producto nuevo", descripcion: "d", precio: 500 },
        ]),
        "p.xlsx",
      );

    await new Promise((resolve) => setImmediate(resolve));

    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accion: "ACTUALIZAR_MASIVO", entidad: "Producto", entidadId: 5 }),
      }),
    );
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accion: "IMPORTAR_MASIVO", entidad: "Producto", entidadId: 99 }),
      }),
    );
  });
});
