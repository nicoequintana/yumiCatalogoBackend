import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { COLUMNAS_ACTUALIZACION, leerArchivo, validarFilaActualizacion } from "./importProductos.js";
import { generarExportacion, productoAFila } from "./exportarProductos.js";

const CATEGORIAS = new Map([["velas", 7]]);

/** Producto "leído de Prisma" con sus relaciones ya cargadas y agrupadas. */
function productoDePrueba(extra = {}) {
  return {
    id: 42,
    sku: "VEL-1234",
    nombre: "Vela de soja",
    descripcion: "Aroma lavanda",
    precio: 1500.5,
    stock: 12,
    categoria: { nombre: "Velas" },
    etiqueta: "Nuevo",
    fraseComercial: "Iluminá tu casa",
    porQueLoVasAQuerer: "Porque dura",
    tePasaEsto: "Se te corta la luz",
    caracteristicas: [{ texto: "Cera de soja" }],
    beneficios: [{ texto: "Dura 40 h" }, { texto: "Sin humo" }],
    usos: [{ texto: "Living" }],
    idealPara: [{ texto: "Regalo" }],
    incluye: [{ texto: "1 vela" }],
    especificaciones: [{ nombre: "Material", valor: "Soja" }],
    ...extra,
  };
}

describe("productoAFila", () => {
  it("mapea el producto al orden de COLUMNAS_ACTUALIZACION", () => {
    const fila = productoAFila(productoDePrueba());

    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("sku")]).toBe("VEL-1234");
    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("nombre")]).toBe("Vela de soja");
    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("precio")]).toBe(1500.5);
    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("categoria")]).toBe("Velas");
    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("beneficios")]).toBe("Dura 40 h\nSin humo");
    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("especificaciones")]).toBe("Material: Soja");
  });

  it("deja en null las listas/especificaciones vacías y la categoría ausente", () => {
    const fila = productoAFila(
      productoDePrueba({
        categoria: null,
        caracteristicas: [],
        beneficios: [],
        usos: [],
        idealPara: [],
        incluye: [],
        especificaciones: [],
      }),
    );

    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("categoria")]).toBeNull();
    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("beneficios")]).toBeNull();
    expect(fila[COLUMNAS_ACTUALIZACION.indexOf("especificaciones")]).toBeNull();
  });
});

describe("generarExportacion — round trip", () => {
  // Este es el test más importante de la feature: si el formato de ida y
  // vuelta entre `generarExportacion` y `validarFilaActualizacion` no
  // coincide, el flujo completo de actualización masiva no sirve.
  it("lo que genera se vuelve a leer idéntico (ida y vuelta completa)", async () => {
    const producto = productoDePrueba();
    const buffer = await generarExportacion([producto], ["Velas"]);

    const filas = await leerArchivo(buffer, COLUMNAS_ACTUALIZACION);
    expect(filas).toHaveLength(1);

    const idsPorSku = new Map([[producto.sku, producto.id]]);
    const { datos, id, errores } = validarFilaActualizacion(
      filas[0].valores,
      filas[0].numeroFila,
      CATEGORIAS,
      idsPorSku,
    );

    expect(errores).toEqual([]);
    expect(id).toBe(producto.id);
    expect(datos).toEqual({
      nombre: producto.nombre,
      descripcion: producto.descripcion,
      precio: "1500.50",
      stock: producto.stock,
      etiqueta: producto.etiqueta,
      categoriaId: 7,
      fraseComercial: producto.fraseComercial,
      porQueLoVasAQuerer: producto.porQueLoVasAQuerer,
      tePasaEsto: producto.tePasaEsto,
      caracteristicas: producto.caracteristicas,
      beneficios: producto.beneficios,
      usos: producto.usos,
      idealPara: producto.idealPara,
      incluye: producto.incluye,
      especificaciones: producto.especificaciones,
    });
  });

  it("un producto sin listas/especificaciones/categoría/etiqueta vuelve como arrays y campos vacíos", async () => {
    const producto = productoDePrueba({
      categoria: null,
      etiqueta: null,
      fraseComercial: null,
      porQueLoVasAQuerer: null,
      tePasaEsto: null,
      caracteristicas: [],
      beneficios: [],
      usos: [],
      idealPara: [],
      incluye: [],
      especificaciones: [],
    });
    const buffer = await generarExportacion([producto], ["Velas"]);

    const filas = await leerArchivo(buffer, COLUMNAS_ACTUALIZACION);
    const idsPorSku = new Map([[producto.sku, producto.id]]);
    const { datos, errores } = validarFilaActualizacion(
      filas[0].valores,
      filas[0].numeroFila,
      CATEGORIAS,
      idsPorSku,
    );

    expect(errores).toEqual([]);
    expect(datos.categoriaId).toBeNull();
    expect(datos.etiqueta).toBeNull();
    expect(datos.caracteristicas).toEqual([]);
    expect(datos.especificaciones).toEqual([]);
  });

  it("escribe una fila por producto, con las categorías cargadas en la hoja Listas", async () => {
    const productos = [productoDePrueba({ id: 1, sku: "A" }), productoDePrueba({ id: 2, sku: "B" })];
    const buffer = await generarExportacion(productos, ["Velas", "Bazar"]);

    const filas = await leerArchivo(buffer, COLUMNAS_ACTUALIZACION);

    expect(filas).toHaveLength(2);
    expect(filas.map((f) => f.valores.sku)).toEqual(["A", "B"]);
  });

  it("no rompe con un catálogo vacío", async () => {
    const buffer = await generarExportacion([], ["Velas"]);

    const filas = await leerArchivo(buffer, COLUMNAS_ACTUALIZACION);

    expect(filas).toEqual([]);
  });

  it("la hoja Listas queda oculta — el admin solo ve Productos al abrir el archivo", async () => {
    const buffer = await generarExportacion([productoDePrueba()], ["Velas"]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);

    const listas = wb.getWorksheet("Listas");
    expect(listas).toBeDefined();
    expect(listas.state).toBe("hidden");
    expect(wb.getWorksheet("Productos").state).toBe("visible");
  });
});
