/**
 * Alta masiva de productos desde una planilla `.xlsx`.
 *
 * Es un flujo aparte del CRUD de a un producto: no sube media, no acepta
 * multipart de fotos y escribe todo en una sola transacción todo-o-nada. Solo
 * comparte con el controller principal la forma de lectura (`products.mapper`)
 * y el generador de SKU.
 */

import { prisma } from "../lib/prisma.js";
import { generarSkusUnicos } from "../lib/sku.js";
import { procesarArchivo, procesarArchivoActualizacion } from "../lib/importProductos.js";
import { generarPlantilla } from "../lib/plantillaProductos.js";
import { generarExportacion } from "../lib/exportarProductos.js";
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

    const skuPorIndice = generarSkusUnicos(procesado.productos.map((p) => p.nombre));

    const creados = await prisma.$transaction(
      procesado.productos.map((producto, indice) =>
        prisma.product.create({
          data: dataDeAlta(producto, skuPorIndice[indice]),
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

/**
 * `GET /api/products/export` — exporta TODO el catálogo (visibles y ocultos,
 * con y sin stock — vista admin, sin paginar) a un `.xlsx` editable, para el
 * flujo de actualización masiva por SKU.
 *
 * Es una LECTURA: sin `logAudit`, mismo criterio que `GET /products`.
 */
export async function exportar(_req, res, next) {
  try {
    // Cuatro columnas, cuatro campos: desde el 25/08/2026 el archivo de
    // actualización no lleva descripción, categoría, etiqueta, contenido
    // comercial, listas ni especificaciones, así que traerlas de la base era
    // pagar los joins de todo el catálogo para descartarlas.
    const productos = await prisma.product.findMany({
      select: { sku: true, nombre: true, precio: true, stock: true },
      orderBy: { id: "asc" },
    });

    const buffer = await generarExportacion(productos);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="productos-export.xlsx"');
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

/** Arma el `data` de creación de un producto nuevo para el `upsert` masivo. Mismo shape que `importar`, pero con un sku ya resuelto por el caller. */
function dataDeAlta(datos, sku) {
  return {
    nombre: datos.nombre,
    descripcion: datos.descripcion,
    precio: datos.precio,
    etiqueta: datos.etiqueta,
    categoriaId: datos.categoriaId,
    sku,
    stock: datos.stock,
    visibleEnCatalogo: false,
    fraseComercial: datos.fraseComercial,
    porQueLoVasAQuerer: datos.porQueLoVasAQuerer,
    tePasaEsto: datos.tePasaEsto,
    caracteristicas: { create: datos.caracteristicas },
    listas: {
      create: [
        ...datos.beneficios.map((item, i) => ({ ...item, tipo: "BENEFICIO", orden: i })),
        ...datos.usos.map((item, i) => ({ ...item, tipo: "USO", orden: i })),
        ...datos.idealPara.map((item, i) => ({ ...item, tipo: "IDEAL_PARA", orden: i })),
        ...datos.incluye.map((item, i) => ({ ...item, tipo: "INCLUYE", orden: i })),
      ],
    },
    especificaciones: { create: datos.especificaciones.map((e, i) => ({ ...e, orden: i })) },
  };
}

/**
 * Arma el `data` de actualización de un producto existente.
 *
 * **Solo `nombre`, `precio` y `stock`.** Es EXACTAMENTE lo que viaja en el
 * `.xlsx` (`COLUMNAS_ACTUALIZACION` en `lib/importProductos.js`), y esa
 * correspondencia es la garantía central de este flujo: lo que el archivo no
 * trae, la actualización no toca.
 *
 * Hasta el 25/08/2026 esta función escribía quince campos y **reemplazaba
 * enteras** las relaciones de contenido con `deleteMany` + `create`. Sumarle
 * acá un campo que la planilla no trae reintroduce ese modo de falla en su
 * peor forma: llegaría `undefined`/`null` en cada fila y le vaciaría ese
 * campo a todo el catálogo de una, sin error y sin nada en pantalla que lo
 * delate. Si hace falta actualizar un campo nuevo por planilla, se agrega
 * primero a `COLUMNAS_ACTUALIZACION` y a la validación de fila — nunca solo
 * acá.
 *
 * `sku`, `visibleEnCatalogo`, `destacado`, `orden`, fotos y video tampoco
 * aparecen, por la misma razón de siempre: al no estar en `data`, Prisma las
 * deja intactas. Se editan por otras vías (el listado del admin, el editor
 * con media).
 */
function dataDeActualizacion(datos) {
  return {
    nombre: datos.nombre,
    precio: datos.precio,
    stock: datos.stock,
  };
}

/**
 * `POST /api/products/actualizar-masivo` — sube el mismo `.xlsx` que exporta
 * `GET /products/export` y actualiza los productos matcheados por `sku`.
 *
 * Cuatro columnas: `sku`, `nombre`, `precio`, `stock`. Solo esos tres últimos
 * campos se escriben. **Todo lo demás del producto queda intacto** —
 * descripción, categoría, etiqueta, contenido comercial, características,
 * listas, especificaciones, `sku`, `visibleEnCatalogo`, `destacado`, `orden`,
 * fotos y video. Ver `dataDeActualizacion`, que es donde esa garantía vive.
 *
 * **Este flujo ya NO crea productos** (cambio del 25/08/2026, junto con el
 * recorte de columnas). Antes un `sku` vacío daba de alta un producto; hoy es
 * error de fila, porque `Product.descripcion` es `NOT NULL` y la planilla dejó
 * de traer esa columna. Las altas van por `POST /products/import`
 * (`AdminImportarProductos`), que sigue usando la plantilla completa.
 *
 * Un `sku` inexistente sigue siendo error de fila: es la protección contra que
 * un SKU mal tipeado pase por otro producto en vez de avisar.
 *
 * Todo o nada, mismo criterio que `importar`: si una sola fila es inválida no
 * se escribe nada.
 */
export async function actualizarMasivo(req, res, next) {
  try {
    if (!req.file) throw httpError(400, "Subí un archivo .xlsx con los productos.");

    // Sin la consulta de categorías: la planilla ya no tiene esa columna, así
    // que no hay nada que resolver contra ella.
    const productosExistentes = await prisma.product.findMany({
      select: { id: true, sku: true, precio: true, stock: true },
    });
    const idsPorSku = new Map(productosExistentes.map((p) => [p.sku, p.id]));
    // Snapshot previo, para que la auditoría pueda mostrar precio/stock
    // antes -> después de cada producto tocado.
    const antesPorId = new Map(
      productosExistentes.map((p) => [p.id, { precio: p.precio.toString(), stock: p.stock }]),
    );

    let procesado;
    try {
      procesado = await procesarArchivoActualizacion(req.file.buffer, idsPorSku);
    } catch (err) {
      // Problema del ARCHIVO (vacío, sin la hoja, supera el límite): no tiene
      // fila a la que apuntar, así que es un 400 con mensaje suelto.
      throw httpError(400, err.message);
    }

    if (procesado.errores.length > 0) {
      return res.status(400).json({
        error: "El archivo tiene errores. No se guardó ningún producto.",
        errores: procesado.errores,
      });
    }

    const resultados = await prisma.$transaction(
      procesado.operaciones.map((op) =>
        prisma.product.update({
          where: { id: op.id },
          data: dataDeActualizacion(op.datos),
          include: PRODUCT_INCLUDE,
        }),
      ),
    );

    // Un renglón de auditoría POR PRODUCTO, no uno por lote — mismo criterio
    // que `eliminarMasivo`/`actualizarVisibilidadMasiva` en
    // `products.controller.js`: la pregunta que se le hace después a
    // `AuditLog` es "¿quién tocó ESTE producto?".
    for (const resultado of resultados) {
      const antes = antesPorId.get(resultado.id);
      logAudit(req, {
        accion: "ACTUALIZAR_MASIVO",
        entidad: "Producto",
        entidadId: resultado.id,
        detalle: {
          precio: { antes: antes?.precio ?? null, despues: resultado.precio.toString() },
          stock: { antes: antes?.stock ?? null, despues: resultado.stock },
        },
      });
    }

    res.json({ actualizados: resultados.length, productos: resultados.map(mapProducto) });
  } catch (err) {
    next(err);
  }
}
