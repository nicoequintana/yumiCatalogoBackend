import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { logAudit } from "../lib/logAudit.js";
import { MAX_FOTOS } from "../lib/limitesMedios.js";
import {
  listarImagenesDeCarpeta,
  eliminarArchivo,
  eliminarCarpeta,
} from "../services/cloudinary.service.js";

/**
 * La carpeta donde el flujo de n8n deposita las imágenes generadas de un
 * producto. El nombre es el `sku`, que genera el servidor y no cambia.
 *
 * NO confundir con la carpeta de la media propia del producto, que es
 * `productos/{id}-{nombre}` (ver `productoMedia.service.js`). Comparten el
 * prefijo `productos/` y son cosas distintas.
 */
const carpetaDeGeneradas = (sku) => `productos/${sku}`;

/** Producto + las fotos que necesita cualquiera de los tres handlers. */
async function traerProducto(id) {
  if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");
  const producto = await prisma.product.findUnique({
    where: { id },
    select: {
      id: true,
      sku: true,
      nombre: true,
      fotos: { select: { id: true, cloudinaryPublicId: true, orden: true } },
    },
  });
  if (!producto) throw httpError(404, "Producto no encontrado.");
  return producto;
}

/**
 * Lista lo que hay en la carpeta generada, marcando cuáles ya son fotos del
 * producto.
 *
 * `adoptada` lo calcula el backend y no el cliente: el frontend no conoce los
 * public ids de las fotos cargadas, porque `mapProducto` no los expone a
 * propósito (son un identificador interno de storage).
 */
export async function listar(req, res, next) {
  try {
    const producto = await traerProducto(Number(req.params.id));
    const carpeta = carpetaDeGeneradas(producto.sku);
    const enUso = new Set(producto.fotos.map((f) => f.cloudinaryPublicId).filter(Boolean));

    const imagenes = (await listarImagenesDeCarpeta(carpeta)).map((imagen) => ({
      ...imagen,
      adoptada: enUso.has(imagen.publicId),
    }));

    res.json({ carpeta, imagenes });
  } catch (err) {
    next(err);
  }
}

/**
 * Adopta imágenes generadas: crea una fila `Foto` que apunta al archivo DONDE
 * YA ESTÁ. No copia ni mueve nada — por eso es instantáneo.
 *
 * El tope se valida contra el total resultante y rechaza la selección ENTERA:
 * adoptar las primeras N en silencio es lo que hace dudar de si el sistema
 * funcionó.
 */
export async function adoptar(req, res, next) {
  try {
    const producto = await traerProducto(Number(req.params.id));
    const pedidos = Array.isArray(req.body?.publicIds) ? req.body.publicIds : [];

    if (pedidos.length === 0) {
      throw httpError(400, "Elegí al menos una imagen para agregar a la ficha.");
    }

    const carpeta = carpetaDeGeneradas(producto.sku);
    const disponibles = await listarImagenesDeCarpeta(carpeta);
    const porId = new Map(disponibles.map((i) => [i.publicId, i]));
    const enUso = new Set(producto.fotos.map((f) => f.cloudinaryPublicId).filter(Boolean));

    for (const publicId of pedidos) {
      // Sin esta guarda, un request armado a mano adoptaría la imagen de otro
      // producto: el public id viene del cliente.
      if (!porId.has(publicId)) {
        throw httpError(400, "Alguna de las imágenes elegidas no está en la carpeta de este producto.");
      }
      if (enUso.has(publicId)) {
        throw httpError(400, "Alguna de las imágenes elegidas ya es una foto del producto.");
      }
    }

    const libres = MAX_FOTOS - producto.fotos.length;
    if (pedidos.length > libres) {
      throw httpError(
        400,
        libres === 0
          ? `El producto ya tiene ${MAX_FOTOS} fotos. Quitá alguna antes de agregar más.`
          : `Elegiste ${pedidos.length} imágenes y solo entran ${libres}. Quitá algunas de la selección.`,
      );
    }

    // `orden` es una secuencia compacta sin huecos: las nuevas continúan desde
    // el final. Empezar en 0 duplicaría la portada.
    const desde = producto.fotos.length;
    const filas = pedidos.map((publicId, indice) => ({
      productId: producto.id,
      url: porId.get(publicId).url,
      cloudinaryPublicId: publicId,
      cloudinaryResourceType: "image",
      orden: desde + indice,
    }));

    await prisma.$transaction(async (tx) => {
      await tx.foto.createMany({ data: filas });
    });

    logAudit(req, {
      accion: "ADOPTAR_IMAGENES",
      entidad: "Producto",
      entidadId: producto.id,
      detalle: { cantidad: filas.length, publicIds: pedidos },
    });

    res.json({ agregadas: filas.length });
  } catch (err) {
    next(err);
  }
}

/**
 * Borra las imágenes generadas que NO están en uso, y la carpeta si queda vacía.
 *
 * ⚠️ La exclusión de las adoptadas es la regla central de este endpoint, no una
 * optimización. Una imagen adoptada y su foto del producto son EL MISMO
 * ARCHIVO (adoptar no copia): borrarla dejaría el catálogo público con una URL
 * de CDN en 404, sin ningún error de este lado y sin nada que lo delate hasta
 * que alguien mire la ficha.
 *
 * Consecuencia asumida: si quedan adoptadas, la carpeta no se vacía y n8n
 * sigue respondiendo `already_processed`. Para regenerar hay que quitar antes
 * esas fotos del producto. La respuesta lo informa.
 */
export async function borrar(req, res, next) {
  try {
    const producto = await traerProducto(Number(req.params.id));
    const carpeta = carpetaDeGeneradas(producto.sku);
    const enUso = new Set(producto.fotos.map((f) => f.cloudinaryPublicId).filter(Boolean));

    const imagenes = await listarImagenesDeCarpeta(carpeta);
    const aBorrar = imagenes.filter((i) => !enUso.has(i.publicId));
    const conservadas = imagenes.length - aBorrar.length;

    // Secuencial y no en paralelo, mismo criterio que el borrado masivo de
    // productos: es una acción de admin y no vale castigar a Cloudinary.
    for (const imagen of aBorrar) {
      await eliminarArchivo(imagen.publicId, "image");
    }

    // `delete_folder` solo funciona con la carpeta vacía.
    const carpetaBorrada = conservadas === 0 && imagenes.length > 0;
    if (carpetaBorrada) await eliminarCarpeta(carpeta);

    logAudit(req, {
      accion: "BORRAR_IMAGENES_GENERADAS",
      entidad: "Producto",
      entidadId: producto.id,
      detalle: { borradas: aBorrar.length, conservadas },
    });

    res.json({ borradas: aBorrar.length, conservadas, carpetaBorrada });
  } catch (err) {
    next(err);
  }
}
