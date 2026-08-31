import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { ALLOWED_PHOTO_MIMES } from "../lib/limitesMedios.js";
import { contenidoCoincideConMime } from "../lib/magicBytes.js";
import { subirArchivo, eliminarArchivo } from "../services/cloudinary.service.js";

/**
 * Cuántas categorías puede mostrar la home a la vez.
 *
 * Es un tope DURO, no un recorte: marcar una cuarta responde 400 en vez de
 * aceptarla y que la home muestre tres al azar. Recortar en silencio dejaría
 * al admin creyendo que eligió algo que no se ve, que es exactamente el modo
 * de falla que esta feature vino a eliminar.
 *
 * El frontend público lo espeja como `MAX_CATEGORIAS_HOME` en
 * `hooks/useCategoriasDestacadas.js` — sync manual entre repos, mismo criterio
 * que `botDetector.js` ↔ `nginx.conf`.
 */
export const MAX_CATEGORIAS_HOME = 3;

/**
 * Carpeta de Cloudinary donde viven las fotos de categoría.
 *
 * **Fuera de producción se antepone `test/`.** La cuenta de Cloudinary es UNA
 * sola para los dos ambientes (hay un único juego de `CLOUDINARY_*`), así que
 * sin esta separación una prueba desde localhost deja archivos mezclados con
 * los reales, y la limpieza de cualquiera de los dos lados se vuelve
 * imposible de hacer sin mirar archivo por archivo.
 *
 * El discriminador es `NODE_ENV`, que el `Dockerfile` fija en `production` y
 * que localmente no existe: el default seguro es el de test, así que un
 * entorno mal configurado ensucia la carpeta de pruebas, nunca la de
 * producción.
 *
 * Es una FUNCIÓN y no una constante para que se evalúe en cada subida — una
 * constante congelaría el valor al importar el módulo y ningún test podría
 * verificar las dos ramas.
 *
 * ⚠️ **Sólo cubre las fotos de categoría.** Los medios de producto siguen
 * subiendo a `productos/{id}-{nombre}` sin prefijo, y ahí el riesgo de pisada
 * es MAYOR (los ids de la base local y la de producción se superponen). No se
 * extendió acá a propósito: el flujo de imágenes generadas lee la carpeta
 * `productos/{sku}` donde escribe n8n, que es un sistema externo y no conoce
 * ningún prefijo — prefijar del lado de YIMA dejaría ese listado buscando en
 * una carpeta que nadie llena. Necesita su propia decisión.
 */
export function carpetaCategorias() {
  return process.env.NODE_ENV === "production" ? "categorias" : "test/categorias";
}

function mapCategoria(categoria) {
  return {
    id: categoria.id,
    nombre: categoria.nombre,
    cantidadProductos: categoria._count?.productos ?? 0,
    imagenUrl: categoria.imagenUrl ?? null,
    destacadaEnHome: categoria.destacadaEnHome ?? false,
    ordenHome: categoria.ordenHome ?? 0,
  };
}

/**
 * Borra de Cloudinary la imagen que una categoría tenía, si tenía alguna.
 *
 * Best-effort a propósito, con el mismo criterio que la limpieza de medios de
 * un producto: si el archivo remoto no se puede borrar, lo que queda es un
 * huérfano en Cloudinary — molesto pero inofensivo. Hacer fallar la operación
 * del admin por eso sería peor: dejaría la fila apuntando a una imagen que
 * quería reemplazar.
 */
async function limpiarImagenRemota(categoria) {
  if (!categoria?.imagenCloudinaryPublicId) return;
  try {
    await eliminarArchivo(
      categoria.imagenCloudinaryPublicId,
      categoria.imagenCloudinaryResourceType ?? "image",
    );
  } catch {
    // Silencio deliberado — ver el comentario de arriba.
  }
}

export async function listar(_req, res, next) {
  try {
    const [categorias, publicadosPorCategoria] = await Promise.all([
      prisma.categoria.findMany({
        orderBy: { nombre: "asc" },
        include: { _count: { select: { productos: true } } },
      }),
      // Cuántos productos de cada categoría ve realmente un visitante.
      //
      // NO se puede derivar de `cantidadProductos`: ese cuenta TODO —ocultos y
      // agotados incluidos— porque el panel lo usa para decidir si una
      // categoría se puede borrar, y ahí ese es el número correcto. Pero la
      // home rankea categorías con esto, y con el conteo total podía destacar
      // una cuyos productos están todos ocultos: la card se veía perfecta y
      // "Ver productos" llevaba a una grilla vacía, sin ningún error.
      //
      // Se resuelve con un `groupBy` aparte en vez de un `_count` filtrado
      // sobre la relación: el `groupBy` es soporte de base del connector, sin
      // depender de que el conteo relacional filtrado esté disponible.
      prisma.product.groupBy({
        by: ["categoriaId"],
        where: { visibleEnCatalogo: true, stock: { gt: 0 }, categoriaId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const publicados = new Map(
      publicadosPorCategoria.map((fila) => [fila.categoriaId, fila._count._all]),
    );

    // `cantidadPublicados` se emite SÓLO acá, no en `crear`/`actualizar`: en
    // esas respuestas el número no se conoce sin otra consulta, y mandar un 0
    // sería peor que omitirlo — se leería como "esta categoría no tiene nada
    // publicado", que es un dato distinto de "no lo sé".
    res.json(
      categorias.map((categoria) => ({
        ...mapCategoria(categoria),
        cantidadPublicados: publicados.get(categoria.id) ?? 0,
      })),
    );
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  try {
    const nombre = req.body?.nombre?.trim();
    if (!nombre) throw httpError(400, "El nombre de la categoría es obligatorio.");

    const existente = await prisma.categoria.findUnique({ where: { nombre } });
    if (existente) throw httpError(400, "Ya existe una categoría con ese nombre.");

    const categoria = await prisma.categoria.create({
      data: { nombre },
      include: { _count: { select: { productos: true } } },
    });

    // Fire-and-forget: la respuesta no espera el insert de auditoría.
    logAudit(req, {
      accion: "CREAR",
      entidad: "Categoria",
      entidadId: categoria.id,
      detalle: { nombre: categoria.nombre },
    });

    res.status(201).json(mapCategoria(categoria));
  } catch (err) {
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Categoría no encontrada.");

    const nombre = req.body?.nombre?.trim();
    if (!nombre) throw httpError(400, "El nombre de la categoría es obligatorio.");

    const actual = await prisma.categoria.findUnique({ where: { id } });
    if (!actual) throw httpError(404, "Categoría no encontrada.");

    if (nombre !== actual.nombre) {
      const duplicada = await prisma.categoria.findUnique({ where: { nombre } });
      if (duplicada) throw httpError(400, "Ya existe una categoría con ese nombre.");
    }

    const categoria = await prisma.categoria.update({
      where: { id },
      data: { nombre },
      include: { _count: { select: { productos: true } } },
    });

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Categoria",
      entidadId: categoria.id,
      detalle: { nombreAnterior: actual.nombre, nombreNuevo: categoria.nombre },
    });

    res.json(mapCategoria(categoria));
  } catch (err) {
    next(err);
  }
}

export async function eliminar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Categoría no encontrada.");

    const categoria = await prisma.categoria.findUnique({ where: { id } });
    if (!categoria) throw httpError(404, "Categoría no encontrada.");

    const cantidadProductos = await prisma.product.count({ where: { categoriaId: id } });
    if (cantidadProductos > 0) {
      throw httpError(
        400,
        `No se puede eliminar: ${cantidadProductos} producto${cantidadProductos === 1 ? "" : "s"} usa${cantidadProductos === 1 ? "" : "n"} esta categoría.`,
      );
    }

    await prisma.categoria.delete({ where: { id } });

    // Después del delete: si la fila no se llegó a borrar, su imagen sigue
    // siendo la imagen de una categoría viva y borrarla la dejaría rota.
    await limpiarImagenRemota(categoria);

    logAudit(req, {
      accion: "ELIMINAR",
      entidad: "Categoria",
      entidadId: id,
      detalle: { nombre: categoria.nombre },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * `PUT /categorias/:id/imagen` — sube (o reemplaza) la foto de la categoría.
 *
 * Va como ruta propia y multipart en vez de sumarle el archivo a
 * `PUT /categorias/:id`: esa ruta edita el nombre y la consume el formulario
 * como JSON, y volverla multipart obligaría a que TODA renombrada mandara un
 * `FormData`. Dos operaciones distintas, dos rutas.
 */
export async function guardarImagen(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Categoría no encontrada.");
    if (!req.file) throw httpError(400, "No llegó ninguna imagen.");

    // Defensa en profundidad (content sniffing): el `fileFilter` de multer ya
    // validó el mimetype declarado contra `ALLOWED_PHOTO_MIMES`, pero es
    // falsificable. Se confirma que los BYTES reales sean los de una imagen
    // permitida antes de subir nada a Cloudinary.
    if (
      !ALLOWED_PHOTO_MIMES.includes(req.file.mimetype) ||
      !contenidoCoincideConMime(req.file.buffer, req.file.mimetype)
    ) {
      throw httpError(400, "El contenido de la imagen no corresponde a un archivo JPG, PNG o WEBP válido.");
    }

    const actual = await prisma.categoria.findUnique({ where: { id } });
    if (!actual) throw httpError(404, "Categoría no encontrada.");

    const subida = await subirArchivo(req.file.buffer, "image", carpetaCategorias());

    const categoria = await prisma.categoria.update({
      where: { id },
      data: {
        imagenUrl: subida.url,
        imagenCloudinaryPublicId: subida.cloudinaryPublicId,
        imagenCloudinaryResourceType: subida.cloudinaryResourceType,
      },
      include: { _count: { select: { productos: true } } },
    });

    // La anterior se borra DESPUÉS de que la nueva quedó guardada. Al revés,
    // un fallo del update dejaría la fila apuntando a un archivo ya borrado:
    // la categoría se vería con la imagen rota en la home pública.
    await limpiarImagenRemota(actual);

    logAudit(req, {
      accion: "ACTUALIZAR_IMAGEN",
      entidad: "Categoria",
      entidadId: id,
      detalle: { nombre: categoria.nombre, imagenUrl: categoria.imagenUrl },
    });

    res.json(mapCategoria(categoria));
  } catch (err) {
    next(err);
  }
}

/** `DELETE /categorias/:id/imagen` — quita la foto y borra el archivo remoto. */
export async function quitarImagen(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Categoría no encontrada.");

    const actual = await prisma.categoria.findUnique({ where: { id } });
    if (!actual) throw httpError(404, "Categoría no encontrada.");

    const categoria = await prisma.categoria.update({
      where: { id },
      data: {
        imagenUrl: null,
        imagenCloudinaryPublicId: null,
        imagenCloudinaryResourceType: null,
      },
      include: { _count: { select: { productos: true } } },
    });

    await limpiarImagenRemota(actual);

    logAudit(req, {
      accion: "QUITAR_IMAGEN",
      entidad: "Categoria",
      entidadId: id,
      detalle: { nombre: categoria.nombre },
    });

    res.json(mapCategoria(categoria));
  } catch (err) {
    next(err);
  }
}

/**
 * `PATCH /categorias/:id/home` — marca o desmarca la categoría para la home.
 *
 * El tope de `MAX_CATEGORIAS_HOME` se valida DENTRO de una transacción
 * serializable: con dos pestañas del panel marcando a la vez, dos lecturas
 * sueltas verían las mismas dos destacadas y las dos escribirían una tercera,
 * dejando cuatro. Mismo criterio que el borrado del último usuario admin.
 *
 * Al marcar, la categoría se manda al final del orden (`max(ordenHome) + 1`)
 * en vez de quedar en el 0 que trae por defecto: sin eso, cada categoría
 * marcada nueva empataría en 0 con el resto y el orden de la home dependería
 * del desempate, no de lo que el admin eligió.
 */
export async function actualizarDestacada(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Categoría no encontrada.");

    const destacada = req.body?.destacadaEnHome;
    if (typeof destacada !== "boolean") {
      throw httpError(400, "El campo destacadaEnHome debe ser true o false.");
    }

    const categoria = await prisma.$transaction(
      async (tx) => {
        const actual = await tx.categoria.findUnique({ where: { id } });
        if (!actual) throw httpError(404, "Categoría no encontrada.");

        let ordenHome = actual.ordenHome;

        if (destacada && !actual.destacadaEnHome) {
          const destacadas = await tx.categoria.findMany({
            where: { destacadaEnHome: true },
            select: { ordenHome: true },
          });

          if (destacadas.length >= MAX_CATEGORIAS_HOME) {
            throw httpError(
              400,
              `La home muestra ${MAX_CATEGORIAS_HOME} categorías. Sacá una antes de agregar otra.`,
            );
          }

          ordenHome = destacadas.reduce((max, c) => Math.max(max, c.ordenHome), -1) + 1;
        }

        return tx.categoria.update({
          where: { id },
          data: { destacadaEnHome: destacada, ordenHome },
          include: { _count: { select: { productos: true } } },
        });
      },
      { isolationLevel: "Serializable" },
    );

    logAudit(req, {
      accion: "DESTACAR_EN_HOME",
      entidad: "Categoria",
      entidadId: id,
      detalle: { nombre: categoria.nombre, destacadaEnHome: categoria.destacadaEnHome },
    });

    res.json(mapCategoria(categoria));
  } catch (err) {
    next(err);
  }
}
