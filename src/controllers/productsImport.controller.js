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
 * Agrupa `listas` (forma cruda de Prisma: `{tipo, texto}`) en los cuatro
 * baldes que espera `productoAFila`. Mismo criterio que
 * `agruparListasPorTipo` de `products.mapper.js`, pero ese helper es privado
 * a ese módulo — se repite acá en vez de exportarlo porque son solo cuatro
 * líneas y este controller no necesita el resto de `products.mapper.js` para
 * esto.
 */
function agruparListasParaExportar(listas) {
  const porTipo = { BENEFICIO: [], USO: [], IDEAL_PARA: [], INCLUYE: [] };
  for (const item of listas) porTipo[item.tipo]?.push({ texto: item.texto });
  return {
    beneficios: porTipo.BENEFICIO,
    usos: porTipo.USO,
    idealPara: porTipo.IDEAL_PARA,
    incluye: porTipo.INCLUYE,
  };
}
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
    const [productos, categorias] = await Promise.all([
      prisma.product.findMany({
        select: {
          sku: true,
          nombre: true,
          descripcion: true,
          precio: true,
          stock: true,
          etiqueta: true,
          fraseComercial: true,
          porQueLoVasAQuerer: true,
          tePasaEsto: true,
          categoria: { select: { nombre: true } },
          caracteristicas: { select: { texto: true }, orderBy: { id: "asc" } },
          listas: { select: { tipo: true, texto: true, orden: true }, orderBy: { orden: "asc" } },
          especificaciones: { select: { nombre: true, valor: true, orden: true }, orderBy: { orden: "asc" } },
        },
        orderBy: { id: "asc" },
      }),
      prisma.categoria.findMany({ select: { nombre: true }, orderBy: { nombre: "asc" } }),
    ]);

    const buffer = await generarExportacion(
      productos.map((p) => ({ ...p, ...agruparListasParaExportar(p.listas) })),
      categorias.map((c) => c.nombre),
    );

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

/** Arma el `data` de actualización de un producto existente. Mismo shape que la versión anterior de `actualizarMasivo`. */
function dataDeActualizacion(datos) {
  return {
    nombre: datos.nombre,
    descripcion: datos.descripcion,
    precio: datos.precio,
    stock: datos.stock,
    etiqueta: datos.etiqueta,
    categoriaId: datos.categoriaId,
    fraseComercial: datos.fraseComercial,
    porQueLoVasAQuerer: datos.porQueLoVasAQuerer,
    tePasaEsto: datos.tePasaEsto,
    // Reemplazo total de las relaciones de contenido, mismo patrón que
    // `actualizar` en `products.controller.js`. `sku`, `visibleEnCatalogo`,
    // `destacado`, `orden` y las relaciones de media NO aparecen acá a
    // propósito: al no estar en `data`, Prisma las deja intactas.
    caracteristicas: { deleteMany: {}, create: datos.caracteristicas },
    listas: {
      deleteMany: {},
      create: [
        ...datos.beneficios.map((item, i) => ({ ...item, tipo: "BENEFICIO", orden: i })),
        ...datos.usos.map((item, i) => ({ ...item, tipo: "USO", orden: i })),
        ...datos.idealPara.map((item, i) => ({ ...item, tipo: "IDEAL_PARA", orden: i })),
        ...datos.incluye.map((item, i) => ({ ...item, tipo: "INCLUYE", orden: i })),
      ],
    },
    especificaciones: {
      deleteMany: {},
      create: datos.especificaciones.map((e, i) => ({ ...e, orden: i })),
    },
  };
}

/**
 * `POST /api/products/actualizar-masivo` — sube el mismo `.xlsx` que exporta
 * `GET /products/export` y hace un UPSERT por fila, matcheado por `sku`:
 *
 * - `sku` vacío → CREA el producto (mismo criterio que `importar`: oculto,
 *   sin media, sku nuevo generado acá).
 * - `sku` presente y existente → ACTUALIZA ese producto. Nunca toca `sku`,
 *   `visibleEnCatalogo`, `destacado`, `orden`, fotos ni video — son
 *   invariantes de seguridad de este flujo, no un detalle de implementación.
 *   Esos campos se editan por otras vías (el listado del admin, el editor
 *   con media).
 * - `sku` presente pero inexistente → error de fila (typo). Es la protección
 *   contra que un SKU mal tipeado cree un duplicado por accidente en vez de
 *   avisar; sigue sin crear en ese caso.
 *
 * Es upsert desde el pedido explícito de reusar el mismo Excel exportado
 * para agregar productos nuevos al final del catálogo, sin tener que ir a la
 * pantalla de alta clásica (`AdminImportarProductos`, que sigue existiendo
 * tal cual para la carga inicial en frío).
 *
 * Todo o nada, mismo criterio que `importar`: si una sola fila es inválida
 * no se escribe nada.
 */
export async function actualizarMasivo(req, res, next) {
  try {
    if (!req.file) throw httpError(400, "Subí un archivo .xlsx con los productos.");

    const [categorias, productosExistentes] = await Promise.all([
      prisma.categoria.findMany({ select: { id: true, nombre: true } }),
      prisma.product.findMany({ select: { id: true, sku: true, precio: true, stock: true } }),
    ]);
    const categoriasPorNombre = new Map(categorias.map((c) => [c.nombre.toLowerCase(), c.id]));
    const idsPorSku = new Map(productosExistentes.map((p) => [p.sku, p.id]));
    // Snapshot previo, para que la auditoría pueda mostrar precio/stock
    // antes -> después de cada producto tocado.
    const antesPorId = new Map(
      productosExistentes.map((p) => [p.id, { precio: p.precio.toString(), stock: p.stock }]),
    );

    let procesado;
    try {
      procesado = await procesarArchivoActualizacion(req.file.buffer, categoriasPorNombre, idsPorSku);
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

    // Los sku de las filas nuevas se generan ANTES de la transacción, todos
    // juntos, para que `generarSkusUnicos` los resuelva sin colisionar entre
    // sí ni contra los que ya existen en la base. Se consumen con un cursor
    // en vez de reordenar `operaciones`: el orden importa para poder auditar
    // después con el mismo índice que devolvió `$transaction`.
    const nombresACrear = procesado.operaciones
      .filter((op) => op.accion === "crear")
      .map((op) => op.datos.nombre);
    const skusGenerados = generarSkusUnicos(nombresACrear, new Set(idsPorSku.keys()));
    let cursorSku = 0;

    const resultados = await prisma.$transaction(
      procesado.operaciones.map((op) =>
        op.accion === "crear"
          ? prisma.product.create({
              data: dataDeAlta(op.datos, skusGenerados[cursorSku++]),
              include: PRODUCT_INCLUDE,
            })
          : prisma.product.update({
              where: { id: op.id },
              data: dataDeActualizacion(op.datos),
              include: PRODUCT_INCLUDE,
            }),
      ),
    );

    let creados = 0;
    let actualizados = 0;

    // Mismo índice en `operaciones` y `resultados`: `$transaction` preserva
    // el orden del array que recibe. Un renglón de auditoría POR PRODUCTO,
    // no uno por lote — mismo criterio que
    // `eliminarMasivo`/`actualizarVisibilidadMasiva` en
    // `products.controller.js`: la pregunta que se le hace después a
    // `AuditLog` es "¿quién tocó ESTE producto?".
    procesado.operaciones.forEach((op, indice) => {
      const resultado = resultados[indice];
      if (op.accion === "crear") {
        creados += 1;
        logAudit(req, {
          accion: "IMPORTAR_MASIVO",
          entidad: "Producto",
          entidadId: resultado.id,
          detalle: { sku: resultado.sku },
        });
      } else {
        actualizados += 1;
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
    });

    res.json({ creados, actualizados, productos: resultados.map(mapProducto) });
  } catch (err) {
    next(err);
  }
}
