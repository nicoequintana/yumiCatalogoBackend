import { describe, expect, it } from "vitest";
import { mapProductoParaN8n } from "./products.mapper.js";

/**
 * Payload que recibe el flujo de generación de imágenes de n8n.
 *
 * Lo consume un agente de IA, así que lo que se afirma acá es tanto lo que SALE
 * como lo que NO sale: los ids de las filas y el estado comercial son ruido que
 * le cuesta al modelo en cada ejecución, y los ids además le sugieren que esos
 * números significan algo.
 */
function filaDeProducto(extra = {}) {
  return {
    id: 7,
    sku: "YIMA-TERMOM-8189",
    nombre: "Termo mate",
    descripcion: "Un termo autocebante",
    precio: { toString: () => "45000" },
    etiqueta: "Nuevo",
    categoria: { id: 1002, nombre: "Cocina" },
    vistas: 12,
    compartidos: 3,
    favoritosCount: 1,
    visibleEnCatalogo: true,
    stock: 5,
    destacado: true,
    orden: 2,
    fraseComercial: "Mate con una mano.",
    porQueLoVasAQuerer: "Entra en la mochila.",
    tePasaEsto: "Hay que llevar todo suelto.",
    caracteristicas: [{ id: 1, texto: "Acero inoxidable" }],
    listas: [
      { id: 10, tipo: "BENEFICIO", texto: "Se ceba solo" },
      { id: 11, tipo: "USO", texto: "Mate en el trabajo" },
      { id: 12, tipo: "IDEAL_PARA", texto: "Materos" },
      { id: 13, tipo: "INCLUYE", texto: "1 × Bombilla" },
    ],
    especificaciones: [{ id: 20, nombre: "Capacidad", valor: "500 mL" }],
    fotos: [],
    video: null,
    createdAt: new Date("2026-08-26"),
    updatedAt: new Date("2026-08-26"),
    ...extra,
  };
}

describe("mapProductoParaN8n", () => {
  it("aplana las listas a arrays de strings", () => {
    const salida = mapProductoParaN8n(filaDeProducto());

    expect(salida.caracteristicas).toEqual(["Acero inoxidable"]);
    expect(salida.beneficios).toEqual(["Se ceba solo"]);
    expect(salida.usos).toEqual(["Mate en el trabajo"]);
    expect(salida.idealPara).toEqual(["Materos"]);
    expect(salida.incluye).toEqual(["1 × Bombilla"]);
  });

  it("emite la categoría como nombre, no como objeto", () => {
    expect(mapProductoParaN8n(filaDeProducto()).categoria).toBe("Cocina");
  });

  it("emite las especificaciones sin id", () => {
    expect(mapProductoParaN8n(filaDeProducto()).especificaciones).toEqual([
      { nombre: "Capacidad", valor: "500 mL" },
    ]);
  });

  it("NO emite ids, estado comercial, contadores ni media", () => {
    const salida = mapProductoParaN8n(filaDeProducto());

    for (const clave of [
      "id",
      "precio",
      "stock",
      "visibleEnCatalogo",
      "destacado",
      "orden",
      "vistas",
      "compartidos",
      "favoritosCount",
      "fotos",
      "video",
      "cantidadFotos",
      "createdAt",
      "updatedAt",
    ]) {
      expect(salida).not.toHaveProperty(clave);
    }
    // El sku SÍ va: nombra los archivos generados del lado de n8n.
    expect(salida.sku).toBe("YIMA-TERMOM-8189");
  });

  it("conserva el contenido descriptivo completo", () => {
    const salida = mapProductoParaN8n(filaDeProducto());

    expect(salida.nombre).toBe("Termo mate");
    expect(salida.descripcion).toBe("Un termo autocebante");
    expect(salida.etiqueta).toBe("Nuevo");
    expect(salida.fraseComercial).toBe("Mate con una mano.");
    expect(salida.porQueLoVasAQuerer).toBe("Entra en la mochila.");
    expect(salida.tePasaEsto).toBe("Hay que llevar todo suelto.");
  });

  it("tolera una ficha incompleta sin romper", () => {
    // Una ficha a medio cargar es un estado normal del catálogo, no un error:
    // los 71 productos cargados en agosto entraron sin categoría en varios
    // casos y con listas vacías.
    const salida = mapProductoParaN8n(
      filaDeProducto({
        categoria: null,
        etiqueta: null,
        fraseComercial: null,
        porQueLoVasAQuerer: null,
        tePasaEsto: null,
        caracteristicas: [],
        listas: [],
        especificaciones: [],
      }),
    );

    expect(salida.categoria).toBeNull();
    expect(salida.etiqueta).toBeNull();
    expect(salida.beneficios).toEqual([]);
    expect(salida.usos).toEqual([]);
    expect(salida.idealPara).toEqual([]);
    expect(salida.incluye).toEqual([]);
    expect(salida.caracteristicas).toEqual([]);
    expect(salida.especificaciones).toEqual([]);
    expect(salida.nombre).toBe("Termo mate");
  });
});
