/**
 * Alta masiva de productos desde una planilla `.xlsx`.
 *
 * Es un flujo aparte del CRUD de a un producto: no sube media, no acepta
 * multipart de fotos y escribe todo en una sola transacción todo-o-nada. Solo
 * comparte con el controller principal la forma de lectura (`products.mapper`)
 * y el generador de SKU.
 */

import { prisma } from "../lib/prisma.js";
import { generarSku } from "../lib/sku.js";
import { procesarArchivo } from "../lib/importProductos.js";
import { generarPlantilla } from "../lib/plantillaProductos.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { PRODUCT_INCLUDE, mapProducto } from "./products.mapper.js";
/**
 * `GET /api/products/import/template` — devuelve el `.xlsx` de plantilla con
 * los desplegables poblados con las categorías que existen ahora mismo.
 *
 * Sin caché a propósito: si el admin crea una categoría y vuelve a descargar
 * la plantilla, la categoría nueva tiene que aparecer en el desplegable.
 */
export async function descargarPlantilla(_req, res, next) {
  try {
    const categorias = await prisma.categoria.findMany({
      select: { nombre: true },
      orderBy: { nombre: "asc" },
    });

    const buffer = await generarPlantilla(categorias.map((c) => c.nombre));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="plantilla-productos.xlsx"');
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

/**
 * `POST /api/products/import` — crea N productos desde un `.xlsx`.
 *
 * Todo o nada: si una sola fila es inválida no se escribe nada. La alternativa
 * (importar las válidas) dejaría la base en un estado que el admin no puede
 * distinguir visualmente — los productos entran ocultos y sin fotos — y como
 * `Product.nombre` no es único, reintentar el archivo corregido duplicaría los
 * que sí habían entrado.
 *
 * Todos los productos entran con `visibleEnCatalogo: false` FORZADO: un
 * producto importado no tiene fotos todavía, y publicarlo lo mostraría como una
 * tarjeta rota en `/coleccion`. Publicar es una acción posterior y explícita.
 */
export async function importar(req, res, next) {
  try {
    if (!req.file) throw httpError(400, "Subí un archivo .xlsx con los productos.");

    // Una sola consulta para todas las filas, no una por fila.
    const categorias = await prisma.categoria.findMany({ select: { id: true, nombre: true } });
    const categoriasPorNombre = new Map(categorias.map((c) => [c.nombre.toLowerCase(), c.id]));

    let procesado;
    try {
      procesado = await procesarArchivo(req.file.buffer, categoriasPorNombre);
    } catch (err) {
      // Problema del ARCHIVO (vacío, sin la hoja, supera el límite): no tiene
      // fila a la que apuntar, así que es un 400 con mensaje suelto.
      throw httpError(400, err.message);
    }

    if (procesado.errores.length > 0) {
      return res.status(400).json({
        error: "El archivo tiene errores. No se importó ningún producto.",
        errores: procesado.errores,
      });
    }

    // `generarSku` usa un sufijo random de 4 dígitos: dos productos con nombres
    // parecidos en el mismo archivo pueden colisionar. `crear` absorbe eso
    // reintentando contra la base, pero acá todos los SKU se generan ANTES de
    // escribir, así que la colisión se resuelve en memoria: se regenera hasta
    // encontrar uno libre dentro del lote. Una colisión contra un SKU que ya
    // está en la base sigue cayendo en el P2002 del error handler central.
    const skusDelLote = new Set();
    const skuPorIndice = procesado.productos.map((producto) => {
      let sku = generarSku(producto.nombre);
      let intentos = 0;
      while (skusDelLote.has(sku) && intentos < 10) {
        sku = generarSku(producto.nombre);
        intentos += 1;
      }
      skusDelLote.add(sku);
      return sku;
    });

    const creados = await prisma.$transaction(
      procesado.productos.map((producto, indice) =>
        prisma.product.create({
          data: {
            nombre: producto.nombre,
            descripcion: producto.descripcion,
            precio: producto.precio,
            etiqueta: producto.etiqueta,
            categoriaId: producto.categoriaId,
            sku: skuPorIndice[indice],
            stock: producto.stock,
            visibleEnCatalogo: false,
            fraseComercial: producto.fraseComercial,
            porQueLoVasAQuerer: producto.porQueLoVasAQuerer,
            tePasaEsto: producto.tePasaEsto,
            caracteristicas: { create: producto.caracteristicas },
            listas: {
              create: [
                ...producto.beneficios.map((item, i) => ({ ...item, tipo: "BENEFICIO", orden: i })),
                ...producto.usos.map((item, i) => ({ ...item, tipo: "USO", orden: i })),
                ...producto.idealPara.map((item, i) => ({ ...item, tipo: "IDEAL_PARA", orden: i })),
                ...producto.incluye.map((item, i) => ({ ...item, tipo: "INCLUYE", orden: i })),
              ],
            },
            especificaciones: {
              create: producto.especificaciones.map((e, i) => ({ ...e, orden: i })),
            },
          },
          include: PRODUCT_INCLUDE,
        }),
      ),
    );

    logAudit(req, {
      accion: "IMPORTAR",
      entidad: "Producto",
      detalle: { cantidad: creados.length, skus: creados.map((p) => p.sku) },
    });

    res.status(201).json({ cantidad: creados.length, productos: creados.map(mapProducto) });
  } catch (err) {
    next(err);
  }
}
