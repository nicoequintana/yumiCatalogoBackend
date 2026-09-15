import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { exigirIdsExistentes } from "../lib/idsExistentes.js";
import {
  LARGO_MAX_FRASE,
  LARGO_MAX_NOMBRE,
  MIN_UNIDADES,
  MAX_UNIDADES,
  VIGENCIAS,
  validarComposicion,
  cuentasCombo,
  alcanzaCombo,
  disponibilidadCombo,
  productoLimitanteCombo,
  condicionComboVigente,
  esComboVigente,
} from "../lib/combos.js";
import {
  PORCENTAJE_MIN,
  PORCENTAJE_MAX,
  esPorcentajeValido,
  resolverDescuentos,
  precioConDescuento,
} from "../lib/precioEfectivo.js";
import { subtotalDeItem } from "../lib/dinero.js";
import { ALLOWED_PHOTO_MIMES } from "../lib/limitesMedios.js";
import { contenidoCoincideConMime } from "../lib/magicBytes.js";
import { subirArchivo, eliminarArchivo } from "../services/cloudinary.service.js";
import { carpetaCampanias } from "./campanias.controller.js";
import { rutaProducto, parsearIdDeRuta, rutaCombo } from "../lib/slug.js";
import { urlDeFoto } from "../lib/fotos.js";
import { logEvento, headersDeEvento } from "../lib/logEvento.js";
import { esRequestDeAdmin } from "../middlewares/auth.middleware.js";
import { MAX_IDS_LISTADO } from "./products.input.js";

/**
 * ADMIN → Combos: conjuntos de productos con descuento condicionado a
 * comprar el conjunto entero. Un solo controller para las dos superficies
 * (admin y pública), igual que `promociones.controller.js`.
 */

function idDeParams(req, campo = "id") {
  const id = Number(req.params[campo]);
  if (!Number.isInteger(id)) throw httpError(404, "Combo no encontrado.");
  return id;
}

function parsearNombre(body) {
  const nombre = typeof body?.nombre === "string" ? body.nombre.trim() : "";
  if (!nombre) throw httpError(400, "El nombre del combo es obligatorio.");
  if (nombre.length > LARGO_MAX_NOMBRE) {
    throw httpError(400, `El nombre no puede superar los ${LARGO_MAX_NOMBRE} caracteres.`);
  }
  return nombre;
}

function parsearFrase(body) {
  const frase = typeof body?.frase === "string" ? body.frase.trim() : "";
  if (!frase) throw httpError(400, "La frase comercial es obligatoria.");
  if (frase.length > LARGO_MAX_FRASE) {
    throw httpError(400, `La frase no puede superar los ${LARGO_MAX_FRASE} caracteres.`);
  }
  return frase;
}

function parsearPorcentaje(body) {
  const porcentaje = Number(body?.porcentaje);
  if (!esPorcentajeValido(porcentaje)) {
    throw httpError(400, `El descuento tiene que ser un número entero entre ${PORCENTAJE_MIN} y ${PORCENTAJE_MAX}.`);
  }
  return porcentaje;
}

function parsearVigencia(body, actual) {
  if (body?.vigencia === undefined) return actual?.vigencia ?? "SIEMPRE";
  if (!VIGENCIAS.includes(body.vigencia)) {
    throw httpError(400, `\`vigencia\` debe ser una de: ${VIGENCIAS.join(", ")}.`);
  }
  return body.vigencia;
}

function parsearItems(body) {
  const items = body?.items;
  if (!Array.isArray(items)) throw httpError(400, "Enviá la lista de productos del combo en `items`.");

  const errores = validarComposicion(items);
  if (errores.length > 0) throw httpError(400, errores[0]);

  return items.map((item) => ({ productId: Number(item.productId), cantidad: Number(item.cantidad) }));
}

const DETALLE_INCLUDE = {
  items: {
    include: {
      product: {
        select: {
          id: true,
          sku: true,
          nombre: true,
          precio: true,
          stock: true,
          // Spec §8.2: la columna "Productos" del listado admin son mini
          // fichas con foto, no solo texto — misma forma que `PUBLIC_INCLUDE`.
          fotos: { select: { url: true, cloudinaryPublicId: true }, orderBy: { orden: "asc" }, take: 1 },
        },
      },
    },
    orderBy: { id: "asc" },
  },
  campanias: { select: { campania: { select: { id: true, nombre: true, estado: true, desde: true, hasta: true } } } },
};

async function buscarOFallar(id, include = DETALLE_INCLUDE) {
  const combo = await prisma.combo.findUnique({ where: { id }, include });
  if (!combo) throw httpError(404, "Combo no encontrado.");
  return combo;
}

/** Los items en la forma que piden las funciones de `lib/combos.js`. */
function itemsParaCuentas(combo) {
  return combo.items.map((item) => ({ precio: item.product.precio, cantidad: item.cantidad }));
}

function itemsParaAlcance(combo) {
  return combo.items.map((item) => ({ stock: item.product.stock, cantidad: item.cantidad }));
}

function mapComboListado(combo) {
  const cuentas = cuentasCombo(itemsParaCuentas(combo), combo.porcentaje);
  const alcanza = alcanzaCombo(itemsParaAlcance(combo));
  const enCampania = combo.campanias?.[0]?.campania ?? null;

  return {
    id: combo.id,
    ruta: rutaCombo(combo),
    nombre: combo.nombre,
    frase: combo.frase,
    porcentaje: combo.porcentaje,
    activo: combo.activo,
    vigencia: combo.vigencia,
    vigente: esComboVigente(combo),
    heroUrl: combo.heroUrl,
    unidades: cuentas.unidades,
    precioSeparado: cuentas.precioSeparado.toString(),
    precioCombo: cuentas.precioCombo.toString(),
    ahorro: cuentas.ahorro.toString(),
    alcanza,
    campania: enCampania ? { id: enCampania.id, nombre: enCampania.nombre, estado: enCampania.estado } : null,
    items: combo.items.map((item) => ({
      productId: item.productId,
      nombre: item.product.nombre,
      cantidad: item.cantidad,
      foto: item.product.fotos?.[0] ? urlDeFoto(item.product.fotos[0]) : null,
    })),
  };
}

function mapComboDetalle(combo) {
  const cuentas = cuentasCombo(itemsParaCuentas(combo), combo.porcentaje);
  const alcanza = alcanzaCombo(itemsParaAlcance(combo));

  return {
    id: combo.id,
    nombre: combo.nombre,
    frase: combo.frase,
    porcentaje: combo.porcentaje,
    activo: combo.activo,
    vigencia: combo.vigencia,
    heroUrl: combo.heroUrl,
    vistas: combo.vistas,
    unidades: cuentas.unidades,
    precioSeparado: cuentas.precioSeparado.toString(),
    precioCombo: cuentas.precioCombo.toString(),
    ahorro: cuentas.ahorro.toString(),
    alcanza,
    campanias: (combo.campanias ?? []).map((c) => ({
      id: c.campania.id,
      nombre: c.campania.nombre,
      estado: c.campania.estado,
      desde: c.campania.desde,
      hasta: c.campania.hasta,
    })),
    items: combo.items.map((item) => ({
      productId: item.productId,
      sku: item.product.sku,
      nombre: item.product.nombre,
      precio: item.product.precio.toString(),
      stock: item.product.stock,
      cantidad: item.cantidad,
    })),
  };
}

export async function listarAdmin(_req, res, next) {
  try {
    const combos = await prisma.combo.findMany({
      include: DETALLE_INCLUDE,
      orderBy: [{ createdAt: "desc" }],
    });
    res.json(combos.map(mapComboListado));
  } catch (err) {
    next(err);
  }
}

export async function obtenerAdminPorId(req, res, next) {
  try {
    res.json(mapComboDetalle(await buscarOFallar(idDeParams(req))));
  } catch (err) {
    next(err);
  }
}

/** Activar exige hero cargado: sin él la página abre con un hueco. */
function exigirHeroSiActivo(activo, heroUrl) {
  if (activo && !heroUrl) {
    throw httpError(400, "Para activar el combo primero cargá la imagen principal.");
  }
}

export async function crear(req, res, next) {
  try {
    const nombre = parsearNombre(req.body);
    const frase = parsearFrase(req.body);
    const porcentaje = parsearPorcentaje(req.body);
    const vigencia = parsearVigencia(req.body);
    const items = parsearItems(req.body);

    await exigirIdsExistentes(prisma.product, items.map((i) => i.productId), { entidad: "Estos productos" });

    const combo = await prisma.combo.create({
      // Nace SIEMPRE apagado (`activo: false`): el body no puede prenderlo al
      // crear, mismo criterio que `Promocion` con `bannerEnHome` — se activa
      // desde un PUT posterior, cuando ya tiene hero.
      data: { nombre, frase, porcentaje, vigencia, activo: false, items: { create: items } },
      include: DETALLE_INCLUDE,
    });

    logAudit(req, { accion: "CREAR", entidad: "Combo", entidadId: combo.id, detalle: { nombre } });

    res.status(201).json(mapComboDetalle(combo));
  } catch (err) {
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = idDeParams(req);
    const actual = await buscarOFallar(id);

    const nombre = parsearNombre(req.body);
    const frase = parsearFrase(req.body);
    const porcentaje = parsearPorcentaje(req.body);
    const vigencia = parsearVigencia(req.body, actual);
    const items = parsearItems(req.body);

    const activo =
      req.body?.activo === undefined
        ? actual.activo
        : (() => {
            if (typeof req.body.activo !== "boolean") throw httpError(400, "`activo` debe ser un booleano.");
            return req.body.activo;
          })();

    // Un combo `CAMPANIA` sin campañas se GUARDA igual: la asociación se hace
    // desde `PUT /campanias/:id/combos` y el editor lo advierte con
    // `campanias` vacío. Lo único que bloquea es activar sin hero.
    exigirHeroSiActivo(activo, actual.heroUrl);

    await exigirIdsExistentes(prisma.product, items.map((i) => i.productId), { entidad: "Estos productos" });

    // Reemplazo de items y edición de la fila en UNA transacción: si el update
    // falla, el combo no queda con los productos nuevos y el precio viejo.
    const combo = await prisma.$transaction(async (tx) => {
      await tx.comboItem.deleteMany({ where: { comboId: id } });
      await tx.comboItem.createMany({ data: items.map((item) => ({ comboId: id, ...item })) });
      return tx.combo.update({
        where: { id },
        data: { nombre, frase, porcentaje, vigencia, activo },
        include: DETALLE_INCLUDE,
      });
    });

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Combo",
      entidadId: id,
      detalle: { anterior: { nombre: actual.nombre, activo: actual.activo }, nuevo: { nombre, activo } },
    });

    res.json(mapComboDetalle(combo));
  } catch (err) {
    next(err);
  }
}

export async function eliminar(req, res, next) {
  try {
    const id = idDeParams(req);
    const combo = await buscarOFallar(id);

    await prisma.combo.delete({ where: { id } });

    logAudit(req, { accion: "ELIMINAR", entidad: "Combo", entidadId: id, detalle: { nombre: combo.nombre } });

    // Después del delete, mismo criterio que `eliminar` de promociones: la fila
    // ya no vuelve, así que un fallo del CDN acá no puede revertir nada — se
    // traga adentro de `limpiarHeroRemoto`.
    await limpiarHeroRemoto(combo);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * Borra el hero anterior en Cloudinary. NO consulta compartidos, mismo
 * criterio que `limpiarArtePromocionRemoto`: los combos no tienen
 * `duplicar`, así que dos combos no pueden apuntar al mismo archivo.
 */
async function limpiarHeroRemoto(combo) {
  const publicId = combo?.heroCloudinaryPublicId;
  if (!publicId) return;
  try {
    await eliminarArchivo(publicId, combo.heroCloudinaryResourceType ?? "image");
  } catch {
    // Silencio deliberado, mismo criterio que el resto del proyecto: un
    // archivo huérfano en el CDN es más barato que romper la operación que
    // ya se guardó en la base.
  }
}

/** `PUT /combos/admin/combos/:id/hero` — la imagen principal del combo. */
export async function guardarHero(req, res, next) {
  try {
    const id = idDeParams(req);
    if (!req.file) throw httpError(400, "No llegó ninguna imagen.");

    if (
      !ALLOWED_PHOTO_MIMES.includes(req.file.mimetype) ||
      !contenidoCoincideConMime(req.file.buffer, req.file.mimetype)
    ) {
      throw httpError(400, "El contenido de la imagen no corresponde a un archivo JPG, PNG o WEBP válido.");
    }

    const actual = await buscarOFallar(id);
    const subida = await subirArchivo(req.file.buffer, "image", carpetaCampanias());

    const combo = await prisma.combo.update({
      where: { id },
      data: {
        heroUrl: subida.url,
        heroCloudinaryPublicId: subida.cloudinaryPublicId,
        heroCloudinaryResourceType: subida.cloudinaryResourceType,
      },
      include: DETALLE_INCLUDE,
    });

    await limpiarHeroRemoto(actual);

    logAudit(req, { accion: "ACTUALIZAR_HERO", entidad: "Combo", entidadId: id, detalle: { nombre: combo.nombre } });

    res.json(mapComboDetalle(combo));
  } catch (err) {
    next(err);
  }
}

/** `DELETE /combos/admin/combos/:id/hero` — apaga el combo: sin hero, la página abriría con un hueco. */
export async function quitarHero(req, res, next) {
  try {
    const id = idDeParams(req);
    const actual = await buscarOFallar(id);

    const combo = await prisma.combo.update({
      where: { id },
      data: { heroUrl: null, heroCloudinaryPublicId: null, heroCloudinaryResourceType: null, activo: false },
      // `activo: false` forzado: sin hero la página abriría con un hueco, así
      // que quitarlo apaga el combo — mismo criterio que exigirlo para
      // activar (`exigirHeroSiActivo`).
      include: DETALLE_INCLUDE,
    });

    await limpiarHeroRemoto(actual);

    logAudit(req, { accion: "QUITAR_HERO", entidad: "Combo", entidadId: id, detalle: { nombre: combo.nombre } });

    res.json(mapComboDetalle(combo));
  } catch (err) {
    next(err);
  }
}

/**
 * `POST /admin/combos/cotizar` — alimenta la vista previa del editor
 * mientras se edita (con debounce del lado del cliente). NO persiste nada.
 *
 * El aviso "Comprando por separado sale más barato" compara `precioCombo`
 * contra la suma de los precios EFECTIVOS de hoy (con promociones vigentes,
 * vía `resolverDescuentos`) — nunca contra el precio de lista.
 *
 * También resuelve las dos extras del editor que el frontend NO puede
 * calcular (spec §8.3.2 y §8.3.3): `limitante` (qué producto topea `alcanza`,
 * para "Lo limita X") e `items[].descuento` (la misma pill de "promo vigente"
 * que arma `GET /products`, por fila del editor).
 */
export async function cotizar(req, res, next) {
  try {
    const items = parsearItems(req.body);
    const porcentaje = parsearPorcentaje(req.body);
    const ids = items.map((i) => i.productId);

    // Primero la existencia (400 con el id faltante), después la lectura
    // completa: con un id inexistente no hay nada que cotizar.
    await exigirIdsExistentes(prisma.product, ids, { entidad: "Estos productos" });
    const productos = await prisma.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, nombre: true, precio: true, stock: true, visibleEnCatalogo: true },
    });
    const porId = new Map(productos.map((p) => [p.id, p]));
    const conProducto = items.map((item) => ({ ...item, producto: porId.get(item.productId) }));

    const cuentas = cuentasCombo(
      conProducto.map((i) => ({ precio: i.producto.precio, cantidad: i.cantidad })),
      porcentaje,
    );
    const { alcanza, disponible, quedanPocos } = disponibilidadCombo(
      conProducto.map((i) => ({
        stock: i.producto.stock,
        cantidad: i.cantidad,
        visibleEnCatalogo: i.producto.visibleEnCatalogo,
      })),
    );

    const descuentos = await resolverDescuentos(prisma, ids);
    const precioSueltoHoy = conProducto.reduce((total, item) => {
      const descuento = descuentos.get(item.productId) ?? null;
      const efectivo = descuento ? precioConDescuento(item.producto.precio, descuento.porcentaje) : null;
      return total.plus(subtotalDeItem({ precioUnitario: efectivo ?? item.producto.precio, cantidad: item.cantidad }));
    }, cuentas.precioSeparado.mul(0));

    const limitanteId = productoLimitanteCombo(
      conProducto.map((item) => ({ productId: item.productId, stock: item.producto.stock, cantidad: item.cantidad })),
    );
    const limitante = limitanteId === null ? null : { productId: limitanteId, nombre: porId.get(limitanteId).nombre };

    res.json({
      precioSeparado: cuentas.precioSeparado.toString(),
      precioCombo: cuentas.precioCombo.toString(),
      ahorro: cuentas.ahorro.toString(),
      unidades: cuentas.unidades,
      alcanza,
      disponible,
      quedanPocos,
      precioSueltoHoy: precioSueltoHoy.toString(),
      avisoMasCaro: cuentas.precioCombo.gt(precioSueltoHoy),
      limitante,
      items: conProducto.map((item) => ({ productId: item.productId, descuento: descuentos.get(item.productId) ?? null })),
    });
  } catch (err) {
    next(err);
  }
}

export const PUBLIC_INCLUDE = {
  items: {
    include: {
      product: {
        select: {
          id: true,
          nombre: true,
          precio: true,
          visibleEnCatalogo: true,
          stock: true,
          categoria: { select: { nombre: true } },
          fotos: { select: { url: true, cloudinaryPublicId: true }, orderBy: { orden: "asc" }, take: 1 },
        },
      },
    },
    orderBy: { id: "asc" },
  },
  campanias: { select: { campania: { select: { estado: true, desde: true, hasta: true } } } },
};

/**
 * El combo en la forma PÚBLICA (spec §6.2). `incluirVigente` suma el flag para
 * `?ids=`. Nunca emite costo: `PUBLIC_INCLUDE` ni siquiera lo selecciona.
 */
export function mapComboPublico(combo, { incluirVigente = false, ahora = new Date() } = {}) {
  const cuentas = cuentasCombo(itemsParaCuentas(combo), combo.porcentaje);
  const { alcanza, disponible, quedanPocos } = disponibilidadCombo(
    combo.items.map((item) => ({
      stock: item.product.stock,
      cantidad: item.cantidad,
      visibleEnCatalogo: item.product.visibleEnCatalogo,
    })),
  );

  return {
    id: combo.id,
    ruta: rutaCombo(combo),
    nombre: combo.nombre,
    frase: combo.frase,
    porcentaje: combo.porcentaje,
    precioSeparado: cuentas.precioSeparado.toString(),
    precioCombo: cuentas.precioCombo.toString(),
    ahorro: cuentas.ahorro.toString(),
    unidades: cuentas.unidades,
    alcanza,
    disponible,
    quedanPocos,
    heroUrl: combo.heroUrl,
    items: combo.items.map((item) => ({
      productId: item.productId,
      nombre: item.product.nombre,
      cantidad: item.cantidad,
      precioLista: item.product.precio.toString(),
      foto: item.product.fotos[0] ? urlDeFoto(item.product.fotos[0]) : null,
      ruta: rutaProducto(item.product),
      categoria: item.product.categoria?.nombre ?? null,
    })),
    ...(incluirVigente ? { vigente: esComboVigente(combo, ahora) } : {}),
  };
}

/** `GET /combos` — vigentes, más nuevos primero; con `?ids=` también los no vigentes, con `vigente`. */
export async function listarPublico(req, res, next) {
  try {
    const ahora = new Date();

    if (typeof req.query.ids === "string" && req.query.ids.trim() !== "") {
      // Mismo tope que `parsearIdsListado` (`products.controller.js`): el
      // `IN (...)` resultante va literal al SQL, y una lista sin límite es un
      // DoS gratis contra la base. Se cuenta sobre los crudos, ANTES de
      // filtrar los inválidos, igual que el listado de productos.
      const crudos = req.query.ids.split(",");
      if (crudos.length > MAX_IDS_LISTADO) {
        throw httpError(400, `No se pueden pedir más de ${MAX_IDS_LISTADO} combos por id en una sola consulta.`);
      }

      const ids = [...new Set(crudos.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
      if (ids.length === 0) return res.json([]);

      const combos = await prisma.combo.findMany({ where: { id: { in: ids } }, include: PUBLIC_INCLUDE });
      return res.json(combos.map((combo) => mapComboPublico(combo, { incluirVigente: true, ahora })));
    }

    const combos = await prisma.combo.findMany({
      where: condicionComboVigente(ahora),
      include: PUBLIC_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
    res.json(combos.map((combo) => mapComboPublico(combo, { ahora })));
  } catch (err) {
    next(err);
  }
}

/** `GET /combos/:idSlug` — 404 si no existe o no está vigente; agotado es 200. */
export async function obtenerPublico(req, res, next) {
  try {
    const id = parsearIdDeRuta(req.params.idSlug);
    if (id === null) throw httpError(404, "Combo no encontrado.");

    const ahora = new Date();
    const combo = await prisma.combo.findUnique({ where: { id }, include: PUBLIC_INCLUDE });
    if (!combo || !esComboVigente(combo, ahora)) throw httpError(404, "Combo no encontrado.");

    // La vista sale del TOKEN (`esRequestDeAdmin`), nunca de `?admin=1`.
    if (!esRequestDeAdmin(req)) {
      await prisma.combo.update({ where: { id }, data: { vistas: { increment: 1 } } });
      logEvento({ tipo: "VISTA_COMBO", comboId: id, ...headersDeEvento(req) });
    }

    res.json(mapComboPublico(combo, { ahora }));
  } catch (err) {
    next(err);
  }
}

/** `GET /combos/opciones` — PÚBLICA. El formulario del panel lee de acá, sin copia manual. */
export function opciones(_req, res) {
  res.json({
    minUnidades: MIN_UNIDADES,
    maxUnidades: MAX_UNIDADES,
    porcentajeMin: PORCENTAJE_MIN,
    porcentajeMax: PORCENTAJE_MAX,
    largoMaxNombre: LARGO_MAX_NOMBRE,
    largoMaxFrase: LARGO_MAX_FRASE,
    vigencias: VIGENCIAS,
  });
}
