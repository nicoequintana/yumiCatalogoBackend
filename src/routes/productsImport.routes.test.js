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

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", { expiresIn: "7d" });
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
      .attach("archivo", await xlsxCon([{ nombre: "A", descripcion: "d", costo: 1 }]), "p.xlsx");

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
          { nombre: "Vela", descripcion: "Lavanda", costo: 1500, categoria: "Velas" },
          { nombre: "Difusor", descripcion: "Cítrico", costo: 2000 },
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
          { nombre: "Vela", descripcion: "Lavanda", costo: 1500 },
          { nombre: "", descripcion: "x", costo: 100 },
          { nombre: "Difusor", descripcion: "x", costo: 2000 },
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
          { nombre: "B", descripcion: "d", costo: 100, categoria: "Bazr" },
        ]),
        "p.xlsx",
      );

    expect(res.status).toBe(400);
    expect(res.body.errores).toHaveLength(2);
    expect(res.body.errores.map((e) => [e.fila, e.columna])).toEqual([
      [2, "costo"],
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

    const filas = Array.from({ length: 20 }, () => ({ nombre: "Vela", descripcion: "d", costo: 100 }));

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
        { nombre: "Vela", descripcion: "d", costo: 100 },
        { nombre: "Vela", descripcion: "d", costo: 100 },
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
      .attach("archivo", await xlsxCon([{ nombre: "Vela", descripcion: "d", costo: 1500 }]), "p.xlsx");

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

  it("devuelve un .xlsx de cinco columnas, sin auditoría (es una lectura)", async () => {
    productFindManyMock.mockResolvedValue([
      { sku: "VEL-1", nombre: "Vela", costo: decimal("1500"), coeficiente: decimal("2.05"), stock: 3 },
    ]);

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

    expect(hoja.getRow(1).values.slice(1)).toEqual(["sku", "nombre", "costo", "coeficiente", "stock"]);
    expect(hoja.getRow(2).values.slice(1)).toEqual(["VEL-1", "Vela", 1500, 2.05, 3]);
    // La hoja `Listas` se fue con las columnas `categoria`/`etiqueta`.
    expect(wb.getWorksheet("Listas")).toBeUndefined();
  });

  // Guarda del costo: el `select` no debe volver a pedir relaciones que la
  // planilla ya no lleva. Con el catálogo entero, esos joins son caros y
  // íntegramente descartables.
  it("consulta solo los cinco campos, sin joins de contenido", async () => {
    productFindManyMock.mockResolvedValue([]);

    await request(buildApp()).get("/api/products/export").set("Authorization", authHeader);

    expect(productFindManyMock).toHaveBeenCalledTimes(1);
    expect(productFindManyMock.mock.calls[0][0].select).toEqual({
      sku: true,
      nombre: true,
      costo: true,
      coeficiente: true,
      stock: true,
    });
    // Tampoco hace falta la consulta de categorías que alimentaba el desplegable.
    expect(categoriaMock.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/products/actualizar-masivo", () => {
  it("responde 401 sin token y no escribe nada", async () => {
    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .attach(
        "archivo",
        await xlsxConActualizacion([{ sku: "VEL-1", nombre: "Vela", costo: 1500, stock: 3 }]),
        "productos.xlsx",
      );

    expect(res.status).toBe(401);
    expect(productUpdateMock).not.toHaveBeenCalled();
  });

  it("responde 400 si no se adjuntó ningún archivo", async () => {
    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(".xlsx");
  });

  it("actualiza por sku y NO toca sku/visibilidad/destacado", async () => {
    productFindManyMock.mockResolvedValue([
      { id: 101, sku: "VEL-1", precio: decimal("1500"), stock: 3 },
    ]);
    productUpdateMock.mockResolvedValue({
      id: 101,
      sku: "VEL-1",
      nombre: "Vela renovada",
      descripcion: "Aroma lavanda",
      precio: decimal("1800"),
      stock: 9,
      visibleEnCatalogo: true,
      destacado: true,
      caracteristicas: [],
      listas: [],
      especificaciones: [],
      fotos: [],
      video: null,
      categoria: null,
      _count: { fotos: 0 },
    });

    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([{ sku: "VEL-1", nombre: "Vela renovada", costo: 1800, stock: 9 }]),
        "productos.xlsx",
      );

    expect(res.status).toBe(200);
    expect(res.body.actualizados).toBe(1);
    // `creados` desapareció del contrato: este flujo ya no da de alta.
    expect(res.body.creados).toBeUndefined();
    expect(productCreateMock).not.toHaveBeenCalled();
    expect(productUpdateMock).toHaveBeenCalledTimes(1);

    // EL test central de esta feature: el `data` lleva CUATRO campos y ninguno
    // más. Cualquier campo extra acá le pisa a todo el catálogo un dato que la
    // planilla nunca trajo, en silencio.
    //
    // `precio` en particular NO puede estar: desde el 31/08/2026 se deriva del
    // costo y solo lo publica `aplicarPreciosMasivo`, así que una subida de
    // planilla deja los productos en `Difiere` hasta que alguien aplique.
    expect(productUpdateMock.mock.calls[0][0]).toMatchObject({ where: { id: 101 } });
    expect(productUpdateMock.mock.calls[0][0].data).toEqual({
      nombre: "Vela renovada",
      costo: "1800",
      coeficiente: "1",
      stock: 9,
    });

    expect(res.body.productos[0].visibleEnCatalogo).toBe(true);
    expect(res.body.productos[0].destacado).toBe(true);
  });

  // Regresión del modo de falla que motivó todo el cambio: si `data` volviera a
  // llevar las relaciones con `deleteMany`, una subida le vaciaría a cada
  // producto las características, listas y especificaciones sin ningún aviso.
  it("no manda deleteMany sobre ninguna relación de contenido", async () => {
    productFindManyMock.mockResolvedValue([
      { id: 101, sku: "VEL-1", precio: decimal("1500"), stock: 3 },
    ]);
    productUpdateMock.mockResolvedValue({
      id: 101,
      sku: "VEL-1",
      nombre: "Vela",
      descripcion: "d",
      precio: decimal("1500"),
      stock: 3,
      caracteristicas: [],
      listas: [],
      especificaciones: [],
      fotos: [],
      video: null,
      categoria: null,
      _count: { fotos: 0 },
    });

    await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([{ sku: "VEL-1", nombre: "Vela", costo: 1500, stock: 3 }]),
        "productos.xlsx",
      );

    const enviado = JSON.stringify(productUpdateMock.mock.calls[0][0].data);
    expect(enviado).not.toContain("deleteMany");
    for (const campo of [
      "descripcion",
      "categoriaId",
      "etiqueta",
      "caracteristicas",
      "listas",
      "especificaciones",
    ]) {
      expect(enviado).not.toContain(campo);
    }
  });

  it("rechaza (400, todo o nada) una fila con sku inexistente y no actualiza ninguna", async () => {
    productFindManyMock.mockResolvedValue([
      { id: 101, sku: "VEL-1", precio: decimal("1500"), stock: 3 },
    ]);

    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([
          { sku: "VEL-1", nombre: "Vela", costo: 1500, stock: 1 },
          { sku: "NOEXISTE", nombre: "Difusor", costo: 2000, stock: 1 },
        ]),
        "productos.xlsx",
      );

    expect(res.status).toBe(400);
    expect(productUpdateMock).not.toHaveBeenCalled();
    expect(res.body.errores).toEqual([
      { fila: 3, columna: "sku", valor: "NOEXISTE", motivo: "No existe ningún producto con este SKU." },
    ]);
  });

  // La rama de alta se eliminó el 25/08/2026 junto con el recorte de columnas:
  // `Product.descripcion` es NOT NULL y la planilla dejó de traerla.
  it("rechaza una fila sin sku — este flujo ya no crea productos", async () => {
    productFindManyMock.mockResolvedValue([
      { id: 101, sku: "VEL-1", precio: decimal("1500"), stock: 3 },
    ]);

    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([{ sku: "", nombre: "Producto nuevo", precio: 500, stock: 1 }]),
        "productos.xlsx",
      );

    expect(res.status).toBe(400);
    expect(productCreateMock).not.toHaveBeenCalled();
    expect(productUpdateMock).not.toHaveBeenCalled();
    expect(res.body.errores[0]).toMatchObject({ columna: "sku" });
  });

  it("audita la actualización por producto, con costeo y stock antes/después", async () => {
    productFindManyMock.mockResolvedValue([
      { id: 101, sku: "VEL-1", costo: decimal("1500"), coeficiente: decimal("1"), stock: 3 },
    ]);
    productUpdateMock.mockResolvedValue({
      id: 101,
      sku: "VEL-1",
      nombre: "Vela renovada",
      descripcion: "d",
      precio: decimal("1500"),
      costo: decimal("1800"),
      coeficiente: decimal("1"),
      stock: 9,
      caracteristicas: [],
      listas: [],
      especificaciones: [],
      fotos: [],
      video: null,
      categoria: null,
      _count: { fotos: 0 },
    });

    await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([{ sku: "VEL-1", nombre: "Vela renovada", costo: 1800, stock: 9 }]),
        "productos.xlsx",
      );

    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accion: "ACTUALIZAR_MASIVO",
          entidad: "Producto",
          entidadId: 101,
          // `precio` NO se audita acá: esta operación ya no lo escribe, así que
          // registrarlo sugeriría un cambio que no ocurrió.
          detalle: JSON.stringify({
            costo: { antes: "1500", despues: "1800" },
            coeficiente: { antes: "1", despues: "1" },
            stock: { antes: 3, despues: 9 },
          }),
        }),
      }),
    );
  });
});

/**
 * Regresión de `.map(mapProducto)`.
 *
 * `.map` pasa el ÍNDICE como segundo argumento y ahí va el objeto de opciones,
 * así que `mapProducto` leía `esAdmin` de un número: las dos rutas —las dos
 * detrás de `requireAuth`— devolvían la forma PÚBLICA, sin `costo`,
 * `coeficiente` ni `estadoPrecio`, en desacuerdo con el resto de las escrituras
 * del panel. Es el pisotón que CLAUDE.md prohíbe explícitamente.
 */
describe("las dos rutas de planilla emiten la forma admin del producto", () => {
  const PRODUCTO_CON_COSTEO = {
    id: 101,
    sku: "VEL-1",
    nombre: "Vela",
    descripcion: "Aroma lavanda",
    // Strings pelados y no el `decimal()` de arriba: `calcularPrecio` normaliza
    // con `new Decimal(valor)`, que sabe leer un string pero no un objeto con
    // solo `toString` — con el doble falso el cálculo daría `null` y el test
    // dejaría de poder distinguir la forma admin de la pública.
    precio: "3075",
    costo: "1500",
    coeficiente: "2.05",
    stock: 3,
    visibleEnCatalogo: false,
    destacado: false,
    caracteristicas: [],
    listas: [],
    especificaciones: [],
    fotos: [],
    video: null,
    categoria: null,
    _count: { fotos: 0 },
  };

  it("POST /import devuelve costo, coeficiente y estadoPrecio", async () => {
    productCreateMock.mockResolvedValue(PRODUCTO_CON_COSTEO);

    const res = await request(buildApp())
      .post("/api/products/import")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxCon([{ nombre: "Vela", descripcion: "Aroma lavanda", costo: 1500, coeficiente: 2.05, stock: 3 }]),
        "productos.xlsx",
      );

    expect(res.status).toBe(201);
    expect(res.body.productos[0]).toMatchObject({
      costo: "1500",
      coeficiente: "2.05",
      precioCalculado: "3075",
    });
    expect(res.body.productos[0].estadoPrecio).toBe("AL_DIA");
  });

  it("POST /actualizar-masivo devuelve costo, coeficiente y estadoPrecio", async () => {
    productFindManyMock.mockResolvedValue([
      { id: 101, sku: "VEL-1", precio: decimal("1500"), stock: 3 },
    ]);
    productUpdateMock.mockResolvedValue(PRODUCTO_CON_COSTEO);

    const res = await request(buildApp())
      .post("/api/products/actualizar-masivo")
      .set("Authorization", authHeader)
      .attach(
        "archivo",
        await xlsxConActualizacion([{ sku: "VEL-1", nombre: "Vela", costo: 1500, coeficiente: 2.05, stock: 3 }]),
        "productos.xlsx",
      );

    expect(res.status).toBe(200);
    expect(res.body.productos[0]).toMatchObject({
      costo: "1500",
      coeficiente: "2.05",
      precioCalculado: "3075",
    });
    expect(res.body.productos[0].estadoPrecio).toBe("AL_DIA");
  });
});
