import { prisma } from "../lib/prisma.js";
import * as googleDrive from "../services/googleDrive.service.js";
import * as cloudinary from "../services/cloudinary.service.js";
import { generarSku } from "../lib/sku.js";
import { logAudit } from "../lib/logAudit.js";
import { logEvento, headersDeEvento } from "../lib/logEvento.js";
import { httpError } from "../lib/httpError.js";
import { PRODUCT_INCLUDE, mapProducto } from "./products.mapper.js";
import {
  parseCaracteristicas,
  parseEspecificaciones,
  parseFotosExistentes,
  parseListas,
  parsearOrdenFotos,
  validarArchivos,
  validarCamposBase,
  validarCamposMerchandising,
  validarOrdenFotos,
} from "./products.input.js";
import {
  limpiarArchivosSubidos,
  limpiarMediaRemota,
  logFallaDeLimpieza,
  sanitizarNombreParaCarpeta,
  subirArchivosNuevos,
} from "../services/productoMedia.service.js";

/**
 * Builds the `where` clause for `listar()` from optional query-string
 * filters (categoria, search, minPrecio/maxPrecio).
 *
 * Malformed values are never a 400/500 on this browse endpoint — a bad
 * `?minPrecio=abc` from a stale link or a fumbled UI control just silently
 * drops that one filter instead of failing the whole listing. Each filter is
 * validated independently before being added.
 *
 * `visibleEnCatalogo: true` (when not in admin mode) is inserted FIRST so it
 * stays the leading key of the `where` object — there's a SQL Server index
 * on `[visibleEnCatalogo, orden]` and this keeps queries aligned with it.
 *
 * `stock: { gt: 0 }` (also only outside admin mode): a product that reached
 * zero stock stops appearing in the public LISTING, so it doesn't take up a
 * slot in the grid. Its detail page stays reachable though (see
 * `obtenerPorId`), showing an "Agotado" badge with the buy CTA disabled — a
 * shared link to an out-of-stock product must not 404. The admin listing
 * still needs to see it (to restock or edit it), so this exclusion is
 * public-only, same as `visibleEnCatalogo`.
 */
function construirFiltrosListado(query, { esAdmin }) {
  const where = {};
  if (!esAdmin) {
    where.visibleEnCatalogo = true;
    where.stock = { gt: 0 };
  }

  if (query.categoria !== undefined) {
    const categoriaId = Number(query.categoria);
    if (!Number.isNaN(categoriaId)) where.categoriaId = categoriaId;
  }

  if (typeof query.search === "string" && query.search !== "") {
    // No `mode: "insensitive"` here on purpose: this database's default
    // collation is SQL_Latin1_General_CP1_CI_AS (case-insensitive already,
    // confirmed live against the dev SQL Server), and the mssql Prisma
    // connector doesn't support the `mode` option at all — passing it
    // throws "Unknown argument mode" at runtime. Plain `contains` is both
    // correct and the only option here.
    where.nombre = { contains: query.search };
  }

  const rangoPrecio = {};
  if (query.minPrecio !== undefined) {
    const min = Number(query.minPrecio);
    if (!Number.isNaN(min)) rangoPrecio.gte = min;
  }
  if (query.maxPrecio !== undefined) {
    const max = Number(query.maxPrecio);
    if (!Number.isNaN(max)) rangoPrecio.lte = max;
  }
  if (Object.keys(rangoPrecio).length > 0) where.precio = rangoPrecio;

  return Object.keys(where).length > 0 ? where : undefined;
}

export async function listar(req, res, next) {
  try {
    const esAdmin = req.query.admin !== undefined;

    const productos = await prisma.product.findMany({
      where: construirFiltrosListado(req.query, { esAdmin }),
      include: PRODUCT_INCLUDE,
      orderBy: [{ orden: "asc" }, { createdAt: "desc" }],
    });
    res.json(productos.map(mapProducto));
  } catch (err) {
    next(err);
  }
}

/**
 * Fetches up to 4 related products for the detail page: same categoriaId OR
 * same etiqueta as the current product (either match counts, not both),
 * excluding the product itself. Short-circuits to `[]` without a DB
 * round-trip when the product has neither field set — that's a normal case
 * (nothing to match on), not an error.
 *
 * Only one level deep: related rows are mapped with plain `mapProducto` and
 * never get their own `relacionados` computed, avoiding recursion.
 */
async function obtenerRelacionados(producto, { esAdmin }) {
  const { categoriaId, etiqueta } = producto;
  if (!categoriaId && !etiqueta) return [];

  const or = [];
  if (categoriaId) or.push({ categoriaId });
  if (etiqueta) or.push({ etiqueta });

  const where = {
    id: { not: producto.id },
    OR: or,
    ...(esAdmin ? {} : { visibleEnCatalogo: true, stock: { gt: 0 } }),
  };

  const relacionados = await prisma.product.findMany({
    where,
    include: PRODUCT_INCLUDE,
    take: 4,
  });

  return relacionados.map(mapProducto);
}

export async function obtenerPorId(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const existe = await prisma.product.findUnique({ where: { id } });
    if (!existe) throw httpError(404, "Producto no encontrado.");

    // Admin edit-form prefills also hit this endpoint but aren't a real
    // visitor view — ?admin=1 (set by AdminProductoForm.jsx) skips the
    // increment so an admin editing a product doesn't inflate its own count.
    const esAdmin = req.query.admin !== undefined;

    // Un producto agotado (`stock <= 0`) SÍ es visible en su ficha de detalle:
    // el visitante ve que existe, con el badge "Agotado" y sin poder comprarlo.
    // Solo se lo excluye del listado público (ver `construirFiltrosListado`),
    // así no ocupa lugar en la grilla pero su link compartido sigue abriendo.
    // `visibleEnCatalogo: false` sí sigue siendo 404: eso es el admin ocultando
    // el producto a propósito, distinto de quedarse sin stock.
    if (!esAdmin && !existe.visibleEnCatalogo) {
      throw httpError(404, "Producto no encontrado.");
    }

    let producto;
    if (esAdmin) {
      producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    } else {
      producto = await prisma.product.update({
        where: { id },
        data: { vistas: { increment: 1 } },
        include: PRODUCT_INCLUDE,
      });
      // El evento es ADITIVO al contador `vistas`, no lo reemplaza: el contador
      // da el total acumulado, el evento agrega el cuándo y el de-dónde para el
      // análisis de tráfico. Va acá adentro a propósito, atado a la misma
      // condición `!esAdmin` que el incremento — un admin abriendo el form de
      // edición no genera una vista. Fire-and-forget: la respuesta no espera.
      logEvento({ tipo: "VISTA_PRODUCTO", productId: id, ...headersDeEvento(req) });
    }

    const relacionados = await obtenerRelacionados(producto, { esAdmin });

    res.json({ ...mapProducto(producto), relacionados });
  } catch (err) {
    next(err);
  }
}

export async function compartir(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const existe = await prisma.product.findUnique({ where: { id } });
    if (!existe) throw httpError(404, "Producto no encontrado.");

    await prisma.product.update({ where: { id }, data: { compartidos: { increment: 1 } } });

    // Aditivo al contador `compartidos` (ver `obtenerPorId`), fire-and-forget.
    logEvento({ tipo: "COMPARTIDO", productId: id, ...headersDeEvento(req) });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function favorito(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const existe = await prisma.product.findUnique({ where: { id } });
    if (!existe) throw httpError(404, "Producto no encontrado.");

    await prisma.product.update({ where: { id }, data: { favoritosCount: { increment: 1 } } });

    // Aditivo al contador `favoritosCount` (ver `obtenerPorId`), fire-and-forget.
    logEvento({ tipo: "FAVORITO_AGREGADO", productId: id, ...headersDeEvento(req) });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  let subidas = null;
  let producto = null;
  try {
    const {
      nombre, descripcion, precio, etiqueta, categoriaId, stock, destacado, orden,
      fraseComercial, porQueLoVasAQuerer, tePasaEsto,
    } = req.body;
    validarCamposBase({ nombre, descripcion, precio }, { esCreacion: true });
    const merchandising = validarCamposMerchandising({ stock, destacado, orden });

    const caracteristicas = parseCaracteristicas(req.body.caracteristicas) ?? [];
    const beneficios = parseListas(req.body.beneficios, "BENEFICIO") ?? [];
    const usos = parseListas(req.body.usos, "USO") ?? [];
    const idealPara = parseListas(req.body.idealPara, "IDEAL_PARA") ?? [];
    const incluye = parseListas(req.body.incluye, "INCLUYE") ?? [];
    const especificaciones = parseEspecificaciones(req.body.especificaciones) ?? [];
    const fotosNuevas = req.files?.fotos ?? [];
    const videoArr = req.files?.video ?? [];

    validarArchivos({ fotosNuevas, fotosExistentesCount: 0, video: videoArr });

    // Create the DB row first (no media yet) so we have a real id — this
    // ordering originally existed to name the product's Drive subfolder
    // (design item 1's ordering fix), and still serves the same purpose for
    // Cloudinary's per-product folder below. Also relied on for the
    // orphan-prevention behavior below (a media-less product row is an
    // accepted partial state on upload failure).
    //
    // sku is NOT NULL + unique, so it must be generated up front (it can't
    // depend on the id, which doesn't exist yet at this point). A handful of
    // retries absorbs the rare random-suffix collision (P2002 on sku)
    // instead of failing the whole request over it.
    const MAX_INTENTOS_SKU = 5;
    for (let intento = 1; intento <= MAX_INTENTOS_SKU; intento++) {
      try {
        producto = await prisma.product.create({
          data: {
            nombre: nombre.trim(),
            descripcion: descripcion.trim(),
            precio: String(precio),
            etiqueta: etiqueta?.trim() || null,
            categoriaId: categoriaId ? Number(categoriaId) : null,
            sku: generarSku(nombre.trim()),
            stock: merchandising.stock ?? 0,
            destacado: merchandising.destacado ?? false,
            orden: merchandising.orden ?? 0,
            caracteristicas: { create: caracteristicas },
            fraseComercial: fraseComercial?.trim() || null,
            porQueLoVasAQuerer: porQueLoVasAQuerer?.trim() || null,
            tePasaEsto: tePasaEsto?.trim() || null,
            listas: {
              create: [
                ...beneficios.map((item, index) => ({ ...item, orden: index })),
                ...usos.map((item, index) => ({ ...item, orden: index })),
                ...idealPara.map((item, index) => ({ ...item, orden: index })),
                ...incluye.map((item, index) => ({ ...item, orden: index })),
              ],
            },
            especificaciones: { create: especificaciones.map((e, index) => ({ ...e, orden: index })) },
          },
          include: PRODUCT_INCLUDE,
        });
        break;
      } catch (err) {
        const esColisionSku = err?.code === "P2002" && err.meta?.target?.includes?.("sku");
        if (!esColisionSku || intento === MAX_INTENTOS_SKU) throw err;
      }
    }

    // No hay un paso previo de "crear carpeta" como tenía Drive: Cloudinary
    // la crea implícitamente al recibir `folder` en la subida.
    //
    // Cloudinary organizes uploads by product, mirroring Drive's old
    // per-product subfolder — see cloudinary.service.js's subirArchivo doc.
    const folder = `productos/${producto.id}-${sanitizarNombreParaCarpeta(nombre.trim())}`;

    subidas = await subirArchivosNuevos({ fotosNuevas, videoNuevo: videoArr[0] ?? null, folder });
    const { fotosSubidas, videoSubido } = subidas;

    producto = await prisma.product.update({
      where: { id: producto.id },
      data: {
        fotos: {
          create: fotosSubidas.map((f, index) => ({
            url: f.url,
            cloudinaryPublicId: f.cloudinaryPublicId,
            cloudinaryResourceType: f.cloudinaryResourceType,
            orden: index,
          })),
        },
        video: videoSubido
          ? {
              create: {
                url: videoSubido.url,
                cloudinaryPublicId: videoSubido.cloudinaryPublicId,
                cloudinaryResourceType: videoSubido.cloudinaryResourceType,
              },
            }
          : undefined,
      },
      include: PRODUCT_INCLUDE,
    });

    // Fire-and-forget: la respuesta no espera el insert de auditoría.
    logAudit(req, {
      accion: "CREAR",
      entidad: "Producto",
      entidadId: producto.id,
      detalle: { nombre: producto.nombre, sku: producto.sku },
    });

    res.status(201).json(mapProducto(producto));
  } catch (err) {
    // Orphan prevention (design D6): clean up any Cloudinary uploads from
    // this batch. The product DB row (if created) is intentionally NOT rolled
    // back — per design item 1, a partially-created product (no media) is
    // an accepted state the admin can fix by editing.
    if (subidas) await limpiarArchivosSubidos({ fotos: subidas.fotosSubidas, video: subidas.videoSubido }, req);
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const existente = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const {
      nombre, descripcion, precio, etiqueta, categoriaId, stock, destacado, orden,
      fraseComercial, porQueLoVasAQuerer, tePasaEsto,
    } = req.body;
    validarCamposBase({ nombre, descripcion, precio }, { esCreacion: false });
    const merchandising = validarCamposMerchandising({ stock, destacado, orden });

    const caracteristicas = parseCaracteristicas(req.body.caracteristicas);
    const beneficios = parseListas(req.body.beneficios, "BENEFICIO");
    const usos = parseListas(req.body.usos, "USO");
    const idealPara = parseListas(req.body.idealPara, "IDEAL_PARA");
    const incluye = parseListas(req.body.incluye, "INCLUYE");
    const especificaciones = parseEspecificaciones(req.body.especificaciones);
    const fotosExistentesIds = parseFotosExistentes(req.body.fotosExistentes) ?? existente.fotos.map((f) => f.id);
    const fotosNuevas = req.files?.fotos ?? [];
    const videoArr = req.files?.video ?? [];
    const eliminarVideo = req.body.eliminarVideo === "true";

    validarArchivos({ fotosNuevas, fotosExistentesCount: fotosExistentesIds.length, video: videoArr });

    // Photos removed by the client (present before, absent from fotosExistentes) get deleted from Drive too.
    const fotosARemover = existente.fotos.filter((f) => !fotosExistentesIds.includes(f.id));

    // Se valida ANTES de subir nada a Cloudinary: si la secuencia es
    // inconsistente conviene fallar con 400 sin haber dejado archivos huérfanos.
    const ordenFotos = parsearOrdenFotos(req.body.ordenFotos);
    validarOrdenFotos(ordenFotos, {
      idsConservados: existente.fotos.filter((f) => fotosExistentesIds.includes(f.id)).map((f) => f.id),
      cantidadNuevas: fotosNuevas.length,
    });

    // Toda subida nueva, sobre CUALQUIER producto (nuevo o legado con media
    // en Drive), va a Cloudinary, agrupada en la carpeta propia del producto
    // — misma idea de agrupación por producto que la subcarpeta de Drive,
    // otro storage. Las fotos que un producto legado YA tiene en Drive quedan
    // intactas: esto solo decide dónde aterriza una subida NUEVA.
    const folder = `productos/${existente.id}-${sanitizarNombreParaCarpeta((nombre ?? existente.nombre).trim())}`;

    const subidas = await subirArchivosNuevos({
      fotosNuevas,
      videoNuevo: videoArr[0] ?? null,
      folder,
    });
    const { fotosSubidas, videoSubido } = subidas;

    let productoActualizado;
    try {
      productoActualizado = await prisma.$transaction(async (tx) => {
        // Text fields
        await tx.product.update({
          where: { id },
          data: {
            nombre: nombre !== undefined ? nombre.trim() : undefined,
            descripcion: descripcion !== undefined ? descripcion.trim() : undefined,
            precio: precio !== undefined ? String(precio) : undefined,
            etiqueta: etiqueta !== undefined ? etiqueta?.trim() || null : undefined,
            categoriaId: categoriaId !== undefined ? (categoriaId ? Number(categoriaId) : null) : undefined,
            stock: merchandising.stock,
            destacado: merchandising.destacado,
            orden: merchandising.orden,
            fraseComercial: fraseComercial !== undefined ? fraseComercial?.trim() || null : undefined,
            porQueLoVasAQuerer: porQueLoVasAQuerer !== undefined ? porQueLoVasAQuerer?.trim() || null : undefined,
            tePasaEsto: tePasaEsto !== undefined ? tePasaEsto?.trim() || null : undefined,
          },
        });

        // Caracteristicas: full replace when provided
        if (caracteristicas !== undefined) {
          await tx.caracteristica.deleteMany({ where: { productId: id } });
          if (caracteristicas.length > 0) {
            await tx.caracteristica.createMany({
              data: caracteristicas.map((c) => ({ ...c, productId: id })),
            });
          }
        }

        // Listas comerciales: full replace per-tipo, only when provided
        for (const [tipo, items] of [
          ["BENEFICIO", beneficios],
          ["USO", usos],
          ["IDEAL_PARA", idealPara],
          ["INCLUYE", incluye],
        ]) {
          if (items === undefined) continue;
          await tx.productoLista.deleteMany({ where: { productId: id, tipo } });
          if (items.length > 0) {
            await tx.productoLista.createMany({
              data: items.map((item, index) => ({ ...item, orden: index, productId: id })),
            });
          }
        }

        // Especificaciones: full replace when provided
        if (especificaciones !== undefined) {
          await tx.especificacion.deleteMany({ where: { productId: id } });
          if (especificaciones.length > 0) {
            await tx.especificacion.createMany({
              data: especificaciones.map((e, index) => ({ ...e, orden: index, productId: id })),
            });
          }
        }

        // Fotos: remove any not in fotosExistentesIds, keep the rest, append new ones, re-normalize orden
        if (fotosARemover.length > 0) {
          await tx.foto.deleteMany({ where: { id: { in: fotosARemover.map((f) => f.id) } } });
        }
        const fotosConservadas = existente.fotos.filter((f) => fotosExistentesIds.includes(f.id));

        if (ordenFotos) {
          // Secuencia explícita: la posición en el array ES el `orden` final,
          // así una foto recién subida puede quedar de portada por delante de
          // las que ya estaban.
          const nuevasPorIndice = fotosSubidas;
          const aCrear = [];

          for (const [posicion, token] of ordenFotos.entries()) {
            if (token.tipo === "existente") {
              await tx.foto.update({ where: { id: token.id }, data: { orden: posicion } });
            } else {
              const subida = nuevasPorIndice[token.index];
              aCrear.push({
                url: subida.url,
                cloudinaryPublicId: subida.cloudinaryPublicId,
                cloudinaryResourceType: subida.cloudinaryResourceType,
                orden: posicion,
                productId: id,
              });
            }
          }

          if (aCrear.length > 0) {
            await tx.foto.createMany({ data: aCrear });
          }
        } else {
          // Sin secuencia explícita: comportamiento histórico — se conserva el
          // orden que ya tenían y las nuevas van al final.
          const ordenBase = fotosConservadas.length;
          for (const [index, foto] of fotosConservadas.entries()) {
            await tx.foto.update({ where: { id: foto.id }, data: { orden: index } });
          }
          if (fotosSubidas.length > 0) {
            await tx.foto.createMany({
              data: fotosSubidas.map((f, index) => ({
                url: f.url,
                cloudinaryPublicId: f.cloudinaryPublicId,
                cloudinaryResourceType: f.cloudinaryResourceType,
                orden: ordenBase + index,
                productId: id,
              })),
            });
          }
        }

        // Video: replace, remove, or leave unchanged
        if (videoSubido) {
          if (existente.video) {
            await tx.video.update({
              where: { productId: id },
              data: {
                url: videoSubido.url,
                cloudinaryPublicId: videoSubido.cloudinaryPublicId,
                cloudinaryResourceType: videoSubido.cloudinaryResourceType,
              },
            });
          } else {
            await tx.video.create({
              data: {
                url: videoSubido.url,
                cloudinaryPublicId: videoSubido.cloudinaryPublicId,
                cloudinaryResourceType: videoSubido.cloudinaryResourceType,
                productId: id,
              },
            });
          }
        } else if (eliminarVideo && existente.video) {
          await tx.video.delete({ where: { productId: id } });
        }

        return tx.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
      });
    } catch (dbErr) {
      // Orphan prevention (design D6): DB write failed after successful Cloudinary upload(s).
      await limpiarArchivosSubidos({ fotos: fotosSubidas, video: videoSubido }, req);
      throw dbErr;
    }

    // DB writes succeeded — now clean up whichever storage backend each
    // removed photo/video actually used. Van todas en paralelo: son hasta 11
    // round trips independientes contra Cloudinary/Drive y el cliente está
    // esperando la respuesta detrás de ellos. Ninguna puede rechazar
    // (`limpiarMediaRemota` traga y registra), así que el `allSettled` solo
    // cubre un throw imprevisto del SDK.
    const limpiezas = fotosARemover.map((foto) => limpiarMediaRemota(foto, "la foto", req));
    if (videoSubido && existente.video) {
      limpiezas.push(limpiarMediaRemota(existente.video, "el video anterior", req));
    } else if (eliminarVideo && existente.video) {
      limpiezas.push(limpiarMediaRemota(existente.video, "el video", req));
    }
    await Promise.allSettled(limpiezas);

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        nombreAnterior: existente.nombre,
        nombreNuevo: productoActualizado.nombre,
        precioAnterior: String(existente.precio),
        precioNuevo: String(productoActualizado.precio),
        stockAnterior: existente.stock,
        stockNuevo: productoActualizado.stock,
      },
    });

    res.json(mapProducto(productoActualizado));
  } catch (err) {
    next(err);
  }
}

export async function actualizarVisibilidad(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const { visibleEnCatalogo } = req.body;
    if (typeof visibleEnCatalogo !== "boolean") {
      throw httpError(400, "visibleEnCatalogo debe ser true o false.");
    }

    const existente = await prisma.product.findUnique({ where: { id } });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.update({
      where: { id },
      data: { visibleEnCatalogo },
      include: PRODUCT_INCLUDE,
    });

    logAudit(req, {
      accion: "ACTUALIZAR_VISIBILIDAD",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        visibleAnterior: existente.visibleEnCatalogo,
        visibleNuevo: producto.visibleEnCatalogo,
      },
    });

    res.json(mapProducto(producto));
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /:id/merchandising — combined endpoint for the two admin-table
 * quick-edit controls (`destacado` toggle, `orden` input), mirroring
 * `actualizarVisibilidad`'s shape. Accepts JSON, so `destacado` arrives as a
 * real boolean here (unlike crear()/actualizar()'s multipart/form-data,
 * where it arrives as a string) — `validarCamposMerchandising()` handles
 * both shapes via `coerceDestacado()`, so this endpoint reuses the same
 * validator as crear()/actualizar() instead of re-checking the rules here.
 * At least one of the two fields must be present; each provided field is
 * validated and written, any omitted field is left untouched.
 */
export async function actualizarMerchandising(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const { destacado, orden } = req.body;

    if (destacado === undefined && orden === undefined) {
      throw httpError(400, "Debe enviar destacado y/o orden.");
    }
    const merchandising = validarCamposMerchandising({ destacado, orden });

    const existente = await prisma.product.findUnique({ where: { id } });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.update({
      where: { id },
      data: { destacado: merchandising.destacado, orden: merchandising.orden },
      include: PRODUCT_INCLUDE,
    });

    logAudit(req, {
      accion: "ACTUALIZAR_MERCHANDISING",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        destacadoAnterior: existente.destacado,
        destacadoNuevo: producto.destacado,
        ordenAnterior: existente.orden,
        ordenNuevo: producto.orden,
      },
    });

    res.json(mapProducto(producto));
  } catch (err) {
    next(err);
  }
}

export async function eliminar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!producto) throw httpError(404, "Producto no encontrado.");

    // Pre-chequeo del historial de ventas, mismo criterio que
    // `categorias.controller.js` con los productos de una categoría.
    //
    // `ItemOrden.product` es `onDelete: NoAction`, así que borrar un producto
    // vendido explota con el error P2003 de Prisma (violación de FK), que el
    // error handler central de `server.js` no mapea: al admin le llegaba un
    // 500 con "Error interno del servidor." y ninguna pista de qué hacer.
    // Preguntando primero se responde un 400 que explica el problema y ofrece
    // la salida correcta (ocultarlo del catálogo en vez de borrarlo).
    //
    // El conteo es barato: `ItemOrden.productId` está indexado.
    const cantidadVentas = await prisma.itemOrden.count({ where: { productId: id } });
    if (cantidadVentas > 0) {
      throw httpError(
        400,
        `No se puede eliminar: el producto aparece en ${cantidadVentas} ${cantidadVentas === 1 ? "orden" : "órdenes"} de compra. ` +
          "Para sacarlo del catálogo sin perder el historial de ventas, ocultalo desde el listado de productos.",
      );
    }

    // DB delete first (design D6/ordering): a dangling DB row is worse than an orphaned Drive file.
    await prisma.product.delete({ where: { id } });

    // Se audita apenas la fila se borró, antes de la limpieza de media: el
    // borrado ya es irreversible en este punto, y la limpieza de Cloudinary/
    // Drive puede fallar sin invalidar el hecho de que el producto se eliminó.
    logAudit(req, {
      accion: "ELIMINAR",
      entidad: "Producto",
      entidadId: id,
      detalle: { nombre: producto.nombre, sku: producto.sku },
    });

    // Always sweep individual files first — a product may have a
    // driveFolderId AND still have some fotos/video whose driveFileId
    // predates that folder (e.g. a legacy product that was edited once
    // after this feature shipped: the new upload went into a fresh
    // subfolder, but its original photos are still in the flat root
    // folder). Deleting the folder alone would leave those orphaned.
    //
    // Los archivos se barren en paralelo (hasta 10 fotos + 1 video), pero el
    // borrado de las carpetas SIGUE SIENDO POSTERIOR y no se puede meter en
    // la misma tanda: `delete_folder` de la Admin API de Cloudinary solo
    // funciona sobre una carpeta vacía, así que adelantarlo la dejaría viva
    // para siempre.
    await Promise.allSettled([
      ...producto.fotos.map((foto) => limpiarMediaRemota(foto, "la foto", req)),
      ...(producto.video ? [limpiarMediaRemota(producto.video, "el video", req)] : []),
    ]);

    // Then remove the (now-empty, or never-used) per-product folders. The
    // Drive one only ever exists for legacy Drive-era products — Cloudinary
    // uploads never create one. La carpeta de Cloudinary usa la misma
    // fórmula de nombre que crear/actualizar, así coincide sin importar
    // cuándo se subió por última vez la media del producto.
    const carpetaCloudinary = `productos/${producto.id}-${sanitizarNombreParaCarpeta(producto.nombre.trim())}`;
    await Promise.allSettled([
      ...(producto.driveFolderId
        ? [
            googleDrive
              .eliminarArchivo(producto.driveFolderId)
              .catch((err) => logFallaDeLimpieza("No se pudo eliminar la carpeta del producto en Drive", err, req)),
          ]
        : []),
      cloudinary
        .eliminarCarpeta(carpetaCloudinary)
        .catch((err) => logFallaDeLimpieza("No se pudo eliminar la carpeta del producto en Cloudinary", err, req)),
    ]);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function eliminarFoto(req, res, next) {
  try {
    const id = Number(req.params.id);
    const fotoId = Number(req.params.fotoId);
    if (Number.isNaN(id) || Number.isNaN(fotoId)) throw httpError(404, "Producto o foto no encontrados.");

    const producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!producto) throw httpError(404, "Producto no encontrado.");

    const foto = producto.fotos.find((f) => f.id === fotoId);
    if (!foto) throw httpError(404, "Foto no encontrada.");

    // DB delete first, then Drive cleanup (same ordering rationale as product delete).
    await prisma.$transaction(async (tx) => {
      await tx.foto.delete({ where: { id: fotoId } });
      const restantes = producto.fotos.filter((f) => f.id !== fotoId);
      for (const [index, f] of restantes.entries()) {
        await tx.foto.update({ where: { id: f.id }, data: { orden: index } });
      }
    });

    await limpiarMediaRemota(foto, "la foto", req);

    logAudit(req, {
      accion: "ELIMINAR_FOTO",
      entidad: "Producto",
      entidadId: id,
      detalle: { fotoId, nombreProducto: producto.nombre },
    });

    const productoActualizado = await prisma.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
    res.json(mapProducto(productoActualizado));
  } catch (err) {
    next(err);
  }
}
