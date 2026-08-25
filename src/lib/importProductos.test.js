import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  parsearLista,
  parsearEspecificaciones,
  validarFila,
  validarFilaActualizacion,
  COLUMNAS,
  COLUMNAS_ACTUALIZACION,
  MAX_FILAS,
  MAX_FILAS_ACTUALIZACION,
  MARCA_EJEMPLO,
  leerArchivo,
  procesarArchivo,
  procesarArchivoActualizacion,
} from "./importProductos.js";

describe("parsearLista", () => {
  it("parte un texto multilínea en un ítem por renglón", () => {
    expect(parsearLista("Recargable por USB\nDura 8 horas")).toEqual([
      { texto: "Recargable por USB" },
      { texto: "Dura 8 horas" },
    ]);
  });

  it("descarta renglones vacíos y aplica trim", () => {
    expect(parsearLista("  Uno  \n\n   \nDos")).toEqual([{ texto: "Uno" }, { texto: "Dos" }]);
  });

  it("soporta saltos de línea de Windows (CRLF)", () => {
    expect(parsearLista("Uno\r\nDos")).toEqual([{ texto: "Uno" }, { texto: "Dos" }]);
  });

  it("devuelve lista vacía para celda vacía, null o undefined", () => {
    expect(parsearLista("")).toEqual([]);
    expect(parsearLista(null)).toEqual([]);
    expect(parsearLista(undefined)).toEqual([]);
  });

  it("NO parte por punto y coma — un ';' es texto legítimo del ítem", () => {
    expect(parsearLista("Recargable; también funciona con pilas")).toEqual([
      { texto: "Recargable; también funciona con pilas" },
    ]);
  });
});

describe("parsearEspecificaciones", () => {
  it("parte cada renglón en nombre y valor por el primer ':'", () => {
    expect(parsearEspecificaciones("Material: ABS\nPeso: 250 g")).toEqual([
      { nombre: "Material", valor: "ABS" },
      { nombre: "Peso", valor: "250 g" },
    ]);
  });

  it("parte solo en el PRIMER ':' — el valor puede contener más", () => {
    expect(parsearEspecificaciones("Horario: 9:00 a 18:00")).toEqual([
      { nombre: "Horario", valor: "9:00 a 18:00" },
    ]);
  });

  it("lanza si un renglón no tiene ':'", () => {
    expect(() => parsearEspecificaciones("Material ABS")).toThrow(
      'Cada especificación debe tener el formato "Nombre: Valor". Renglón inválido: "Material ABS".',
    );
  });

  it("lanza si el nombre está vacío", () => {
    expect(() => parsearEspecificaciones(": ABS")).toThrow('Renglón inválido: ": ABS".');
  });

  it("lanza si el valor está vacío", () => {
    expect(() => parsearEspecificaciones("Material:")).toThrow('Renglón inválido: "Material:".');
  });

  it("devuelve lista vacía para celda vacía", () => {
    expect(parsearEspecificaciones("")).toEqual([]);
    expect(parsearEspecificaciones(null)).toEqual([]);
  });
});

const CATEGORIAS = new Map([
  ["velas", 7],
  ["bazar", 9],
]);

function filaValida(extra = {}) {
  return { nombre: "Vela de soja", descripcion: "Aroma lavanda", precio: 1500, ...extra };
}

describe("validarFila", () => {
  it("mapea una fila mínima válida, con stock 0 por defecto", () => {
    const { datos, errores } = validarFila(filaValida(), 2, CATEGORIAS);

    expect(errores).toEqual([]);
    expect(datos).toEqual({
      nombre: "Vela de soja",
      descripcion: "Aroma lavanda",
      precio: "1500",
      stock: 0,
      etiqueta: null,
      categoriaId: null,
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
  });

  it("resuelve la categoría a su id, sin distinguir mayúsculas ni espacios", () => {
    const { datos, errores } = validarFila(filaValida({ categoria: "  VELAS " }), 2, CATEGORIAS);

    expect(errores).toEqual([]);
    expect(datos.categoriaId).toBe(7);
  });

  it("rechaza una categoría inexistente con fila y columna", () => {
    const { datos, errores } = validarFila(filaValida({ categoria: "Bazr" }), 12, CATEGORIAS);

    expect(datos).toBeNull();
    expect(errores).toEqual([
      { fila: 12, columna: "categoria", valor: "Bazr", motivo: "La categoría no existe." },
    ]);
  });

  it("rechaza nombre y descripción vacíos", () => {
    const { errores } = validarFila({ nombre: "   ", descripcion: "", precio: 100 }, 3, CATEGORIAS);

    expect(errores).toEqual([
      { fila: 3, columna: "nombre", valor: "   ", motivo: "El nombre es obligatorio." },
      { fila: 3, columna: "descripcion", valor: "", motivo: "La descripción es obligatoria." },
    ]);
  });

  it("acumula TODOS los errores de la fila, no corta en el primero", () => {
    const { errores } = validarFila({ nombre: "", descripcion: "", precio: "abc" }, 5, CATEGORIAS);

    expect(errores).toHaveLength(3);
    expect(errores.map((e) => e.columna)).toEqual(["nombre", "descripcion", "precio"]);
  });

  it("rechaza precio no numérico, cero, negativo o con centavos", () => {
    // "1500,50" y "1500.50" son el MISMO caso: la coma se sigue interpretando
    // como separador decimal, pero solo para poder detectar los centavos y
    // rechazarlos. `Product.precio` es `Decimal(10, 0)`.
    for (const precio of ["abc", 0, -5, "1500,50", "1500.50", 0.5]) {
      const { errores } = validarFila(filaValida({ precio }), 4, CATEGORIAS);
      expect(errores).toEqual([
        {
          fila: 4,
          columna: "precio",
          valor: precio,
          motivo: "El precio debe ser un número entero mayor a 0, sin decimales.",
        },
      ]);
    }
  });

  it("acepta el precio como texto con separador de miles ausente y lo normaliza a entero", () => {
    const { datos, errores } = validarFila(filaValida({ precio: "1500" }), 2, CATEGORIAS);

    expect(errores).toEqual([]);
    expect(datos.precio).toBe("1500");
  });

  // Excel guarda un 1500 tipeado en una celda con formato de moneda como
  // `1500` a secas, pero un archivo generado por otra herramienta puede traer
  // "1500,00". Los centavos en cero NO son centavos: se acepta y se normaliza.
  it("acepta decimales en cero y los normaliza sin cola", () => {
    const { datos, errores } = validarFila(filaValida({ precio: "1500,00" }), 2, CATEGORIAS);

    expect(errores).toEqual([]);
    expect(datos.precio).toBe("1500");
  });

  it("rechaza stock negativo o no entero", () => {
    expect(validarFila(filaValida({ stock: -1 }), 6, CATEGORIAS).errores).toEqual([
      { fila: 6, columna: "stock", valor: -1, motivo: "El stock debe ser un número entero mayor o igual a 0." },
    ]);
    expect(validarFila(filaValida({ stock: 2.5 }), 6, CATEGORIAS).errores).toHaveLength(1);
  });

  it("convierte un error de especificaciones en un error de fila", () => {
    const { datos, errores } = validarFila(filaValida({ especificaciones: "Material ABS" }), 8, CATEGORIAS);

    expect(datos).toBeNull();
    expect(errores).toEqual([
      {
        fila: 8,
        columna: "especificaciones",
        valor: "Material ABS",
        motivo:
          'Cada especificación debe tener el formato "Nombre: Valor". Renglón inválido: "Material ABS".',
      },
    ]);
  });

  it("mapea todos los campos opcionales cuando vienen completos", () => {
    const { datos } = validarFila(
      filaValida({
        stock: 12,
        categoria: "Velas",
        etiqueta: "Nuevo",
        fraseComercial: "Iluminá tu casa",
        porQueLoVasAQuerer: "Porque dura",
        tePasaEsto: "Se te corta la luz",
        caracteristicas: "Cera de soja",
        beneficios: "Dura 40 h\nSin humo",
        usos: "Living",
        idealPara: "Regalo",
        incluye: "1 vela",
        especificaciones: "Material: Soja",
      }),
      2,
      CATEGORIAS,
    );

    expect(datos.stock).toBe(12);
    expect(datos.categoriaId).toBe(7);
    expect(datos.etiqueta).toBe("Nuevo");
    expect(datos.fraseComercial).toBe("Iluminá tu casa");
    expect(datos.beneficios).toEqual([{ texto: "Dura 40 h" }, { texto: "Sin humo" }]);
    expect(datos.especificaciones).toEqual([{ nombre: "Material", valor: "Soja" }]);
  });
});

/** Arma un .xlsx en memoria con las filas dadas, para testear el parseo real. */
async function construirXlsx(filas) {
  const wb = new ExcelJS.Workbook();
  const hoja = wb.addWorksheet("Productos");
  hoja.addRow(COLUMNAS);
  for (const fila of filas) hoja.addRow(COLUMNAS.map((c) => fila[c] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("leerArchivo", () => {
  it("lee las filas indexadas por nombre de columna", async () => {
    const buffer = await construirXlsx([
      { nombre: "Vela", descripcion: "Lavanda", precio: 1500, stock: 3 },
    ]);

    const filas = await leerArchivo(buffer);

    expect(filas).toHaveLength(1);
    expect(filas[0].numeroFila).toBe(2);
    expect(filas[0].valores.nombre).toBe("Vela");
    expect(filas[0].valores.precio).toBe(1500);
    expect(filas[0].valores.stock).toBe(3);
  });

  it("numera las filas como se ven en Excel (encabezado = 1)", async () => {
    const buffer = await construirXlsx([
      { nombre: "A", descripcion: "d", precio: 1 },
      { nombre: "B", descripcion: "d", precio: 1 },
    ]);

    const filas = await leerArchivo(buffer);

    expect(filas.map((f) => f.numeroFila)).toEqual([2, 3]);
  });

  it("ignora filas totalmente vacías", async () => {
    const buffer = await construirXlsx([
      { nombre: "A", descripcion: "d", precio: 1 },
      {},
      { nombre: "B", descripcion: "d", precio: 1 },
    ]);

    const filas = await leerArchivo(buffer);

    expect(filas.map((f) => f.valores.nombre)).toEqual(["A", "B"]);
  });

  it("descarta la fila de ejemplo de la plantilla (nombre con MARCA_EJEMPLO)", async () => {
    const buffer = await construirXlsx([
      { nombre: `${MARCA_EJEMPLO} — Vela de soja lavanda`, descripcion: "d", precio: 1500 },
      { nombre: "Producto real", descripcion: "d", precio: 1000 },
    ]);

    const filas = await leerArchivo(buffer);

    expect(filas.map((f) => f.valores.nombre)).toEqual(["Producto real"]);
  });

  it("lanza si el archivo no tiene la hoja Productos", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Otra");
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    await expect(leerArchivo(buffer)).rejects.toThrow(
      'El archivo no tiene una hoja llamada "Productos". Descargá la plantilla y completala.',
    );
  });

  it("acepta un array de columnas por parámetro, para hojas con otra forma (ej. sku primero)", async () => {
    const columnas = ["sku", "nombre"];
    const wb = new ExcelJS.Workbook();
    const hoja = wb.addWorksheet("Productos");
    hoja.addRow(columnas);
    hoja.addRow(["SKU-1", "Vela"]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const filas = await leerArchivo(buffer, columnas);

    expect(filas).toHaveLength(1);
    expect(filas[0].valores).toEqual({ sku: "SKU-1", nombre: "Vela" });
  });

  it("sin el parámetro sigue usando COLUMNAS (default), como antes", async () => {
    const buffer = await construirXlsx([{ nombre: "Vela", descripcion: "d", precio: 1 }]);

    const filas = await leerArchivo(buffer);

    expect(filas[0].valores.nombre).toBe("Vela");
    expect(filas[0].valores.precio).toBe(1);
  });
});

describe("procesarArchivo", () => {
  it("devuelve los productos listos cuando todas las filas son válidas", async () => {
    const buffer = await construirXlsx([
      { nombre: "Vela", descripcion: "Lavanda", precio: 1500 },
      { nombre: "Difusor", descripcion: "Cítrico", precio: 2000, categoria: "Velas" },
    ]);

    const { productos, errores } = await procesarArchivo(buffer, CATEGORIAS);

    expect(errores).toEqual([]);
    expect(productos).toHaveLength(2);
    expect(productos[1].categoriaId).toBe(7);
  });

  it("acumula errores de TODAS las filas malas y no devuelve productos", async () => {
    const buffer = await construirXlsx([
      { nombre: "Vela", descripcion: "Lavanda", precio: 1500 },
      { nombre: "", descripcion: "x", precio: 1 },
      { nombre: "Difusor", descripcion: "x", precio: "abc" },
    ]);

    const { productos, errores } = await procesarArchivo(buffer, CATEGORIAS);

    expect(productos).toEqual([]);
    expect(errores).toHaveLength(2);
    expect(errores.map((e) => e.fila)).toEqual([3, 4]);
  });

  it("lanza si el archivo no tiene ninguna fila de datos", async () => {
    const buffer = await construirXlsx([]);

    await expect(procesarArchivo(buffer, CATEGORIAS)).rejects.toThrow(
      "El archivo no tiene ninguna fila para importar.",
    );
  });

  it(`lanza si el archivo supera las ${MAX_FILAS} filas`, async () => {
    const muchas = Array.from({ length: MAX_FILAS + 1 }, (_, i) => ({
      nombre: `P${i}`,
      descripcion: "d",
      precio: 1,
    }));
    const buffer = await construirXlsx(muchas);

    await expect(procesarArchivo(buffer, CATEGORIAS)).rejects.toThrow(
      `El archivo tiene más de ${MAX_FILAS} filas. Dividilo en varios archivos.`,
    );
  });

  it(`deja de acumular filas apenas supera las ${MAX_FILAS} (corte temprano, no al final)`, async () => {
    // Robustez de memoria: antes se cargaba el workbook ENTERO en `filas` y
    // recién después se comparaba contra el tope. Con el corte temprano,
    // `leerArchivo` acumula a lo sumo MAX_FILAS + 1 — lo justo para que
    // `procesarArchivo` detecte el exceso con el mismo mensaje de siempre.
    const muchas = Array.from({ length: MAX_FILAS + 25 }, (_, i) => ({
      nombre: `P${i}`,
      descripcion: "d",
      precio: 1,
    }));
    const buffer = await construirXlsx(muchas);

    const filas = await leerArchivo(buffer);

    expect(filas).toHaveLength(MAX_FILAS + 1);
  });
});

/** Arma un .xlsx en memoria con COLUMNAS_ACTUALIZACION (sku primero). */
async function construirXlsxActualizacion(filas) {
  const wb = new ExcelJS.Workbook();
  const hoja = wb.addWorksheet("Productos");
  hoja.addRow(COLUMNAS_ACTUALIZACION);
  for (const fila of filas) hoja.addRow(COLUMNAS_ACTUALIZACION.map((c) => fila[c] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function filaActualizacionValida(extra = {}) {
  return { sku: "VEL-1", nombre: "Vela de soja", precio: 1500, stock: 7, ...extra };
}

describe("validarFilaActualizacion", () => {
  const IDS_POR_SKU = new Map([
    ["VEL-1", 101],
    ["VEL-2", 102],
  ]);

  it("mapea una fila válida y resuelve el id por sku", () => {
    const { datos, id, errores } = validarFilaActualizacion(
      filaActualizacionValida({ sku: "VEL-2", nombre: "Vela renovada", precio: 1800, stock: 12 }),
      2,
      IDS_POR_SKU,
    );

    expect(errores).toEqual([]);
    expect(id).toBe(102);
    // EXACTAMENTE tres campos, no `objectContaining`: que no aparezca ninguno
    // más es el contrato de este flujo. Un campo de más acá termina en
    // `dataDeActualizacion` pisando dato que la planilla nunca trajo.
    expect(datos).toEqual({ nombre: "Vela renovada", precio: "1800", stock: 12 });
  });

  // La rama de alta por sku vacío se eliminó el 25/08/2026: la planilla dejó
  // de traer `descripcion`, que es NOT NULL, así que un producto nuevo creado
  // desde este archivo no puede existir.
  it("rechaza sku vacío — este archivo ya no crea productos", () => {
    const { datos, id, errores } = validarFilaActualizacion(
      filaActualizacionValida({ sku: undefined }),
      2,
      IDS_POR_SKU,
    );

    expect(datos).toBeNull();
    expect(id).toBeNull();
    expect(errores).toEqual([
      {
        fila: 2,
        columna: "sku",
        valor: "",
        motivo: "El SKU es obligatorio. Este archivo solo actualiza productos que ya existen.",
      },
    ]);
  });

  it("rechaza sku inexistente (typo) — para no pasar por otro producto sin avisar", () => {
    const { datos, id, errores } = validarFilaActualizacion(
      filaActualizacionValida({ sku: "NOEXISTE" }),
      5,
      IDS_POR_SKU,
    );

    expect(datos).toBeNull();
    expect(id).toBeNull();
    expect(errores).toEqual([
      { fila: 5, columna: "sku", valor: "NOEXISTE", motivo: "No existe ningún producto con este SKU." },
    ]);
  });

  it("aplica las reglas de campo y acumula todos los errores de la fila", () => {
    const { datos, errores } = validarFilaActualizacion(
      filaActualizacionValida({ nombre: "", precio: "abc" }),
      3,
      IDS_POR_SKU,
    );

    expect(datos).toBeNull();
    expect(errores).toEqual([
      { fila: 3, columna: "nombre", valor: "", motivo: "El nombre es obligatorio." },
      {
        fila: 3,
        columna: "precio",
        valor: "abc",
        motivo: "El precio debe ser un número entero mayor a 0, sin decimales.",
      },
    ]);
  });

  // A diferencia del alta, acá la celda vacía NO significa "0": significaría
  // poner en cero el stock de un producto que ya tenía existencias, que casi
  // nunca es lo que quiso quien dejó la celda sin tocar.
  it("exige stock: una celda vacía es error, no un 0 implícito", () => {
    for (const vacio of ["", null, undefined]) {
      const { datos, errores } = validarFilaActualizacion(
        filaActualizacionValida({ stock: vacio }),
        4,
        IDS_POR_SKU,
      );

      expect(datos).toBeNull();
      expect(errores).toEqual([
        { fila: 4, columna: "stock", valor: "", motivo: "El stock es obligatorio." },
      ]);
    }
  });

  it("acepta stock 0 explícito — marcar algo como agotado es legítimo", () => {
    const { datos, errores } = validarFilaActualizacion(
      filaActualizacionValida({ stock: 0 }),
      2,
      IDS_POR_SKU,
    );

    expect(errores).toEqual([]);
    expect(datos.stock).toBe(0);
  });

  it("rechaza stock negativo o no entero", () => {
    expect(validarFilaActualizacion(filaActualizacionValida({ stock: -1 }), 6, IDS_POR_SKU).errores).toEqual([
      { fila: 6, columna: "stock", valor: -1, motivo: "El stock debe ser un número entero mayor o igual a 0." },
    ]);
    expect(validarFilaActualizacion(filaActualizacionValida({ stock: 2.5 }), 6, IDS_POR_SKU).errores).toHaveLength(1);
  });

  // Guarda de regresión del recorte de columnas: aunque alguien pegue columnas
  // viejas en el archivo, no tienen que llegar a `datos` — si llegaran,
  // `dataDeActualizacion` podría empezar a escribirlas.
  it("ignora columnas que ya no son parte del archivo", () => {
    const { datos, errores } = validarFilaActualizacion(
      filaActualizacionValida({ descripcion: "texto viejo", categoria: "Velas", etiqueta: "Nuevo" }),
      2,
      IDS_POR_SKU,
    );

    expect(errores).toEqual([]);
    expect(datos).toEqual({ nombre: "Vela de soja", precio: "1500", stock: 7 });
  });
});

describe("procesarArchivoActualizacion", () => {
  it("devuelve una operacion por fila, con el id resuelto", async () => {
    const buffer = await construirXlsxActualizacion([
      { sku: "VEL-1", nombre: "Vela renovada", precio: 1800, stock: 9 },
    ]);
    const idsPorSku = new Map([["VEL-1", 101]]);

    const { operaciones, errores } = await procesarArchivoActualizacion(buffer, idsPorSku);

    expect(errores).toEqual([]);
    expect(operaciones).toEqual([
      { id: 101, datos: { nombre: "Vela renovada", precio: "1800", stock: 9 } },
    ]);
  });

  it("todo o nada: una fila con sku inexistente (typo) invalida el archivo entero", async () => {
    const buffer = await construirXlsxActualizacion([
      { sku: "VEL-1", nombre: "Vela", precio: 1500, stock: 1 },
      { sku: "NOEXISTE", nombre: "Difusor", precio: 2000, stock: 1 },
    ]);
    const idsPorSku = new Map([["VEL-1", 101]]);

    const { operaciones, errores } = await procesarArchivoActualizacion(buffer, idsPorSku);

    expect(operaciones).toEqual([]);
    expect(errores).toEqual([
      { fila: 3, columna: "sku", valor: "NOEXISTE", motivo: "No existe ningún producto con este SKU." },
    ]);
  });

  it("todo o nada: una fila sin sku también invalida el archivo entero", async () => {
    const buffer = await construirXlsxActualizacion([
      { sku: "VEL-1", nombre: "Vela", precio: 1500, stock: 1 },
      { sku: "", nombre: "Producto nuevo", precio: 500, stock: 1 },
    ]);

    const { operaciones, errores } = await procesarArchivoActualizacion(buffer, new Map([["VEL-1", 101]]));

    expect(operaciones).toEqual([]);
    expect(errores).toHaveLength(1);
    expect(errores[0].columna).toBe("sku");
  });

  it(`lanza si el archivo supera las ${MAX_FILAS_ACTUALIZACION} filas`, async () => {
    const muchas = Array.from({ length: MAX_FILAS_ACTUALIZACION + 1 }, (_, i) => ({
      sku: `SKU-${i}`,
      nombre: `P${i}`,
      precio: 1,
      stock: 0,
    }));
    const buffer = await construirXlsxActualizacion(muchas);

    await expect(procesarArchivoActualizacion(buffer, new Map())).rejects.toThrow(
      `El archivo tiene más de ${MAX_FILAS_ACTUALIZACION} filas. Dividilo en varios archivos.`,
    );
  });
});
