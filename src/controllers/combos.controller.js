import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { exigirIdsExistentes } from "../lib/idsExistentes.js";
import {
  LARGO_MAX_FRASE,
  LARGO_MAX_NOMBRE,
  VIGENCIAS,
  validarComposicion,
  cuentasCombo,
  alcanzaCombo,
} from "../lib/combos.js";
import { PORCENTAJE_MIN, PORCENTAJE_MAX, esPorcentajeValido } from "../lib/precioEfectivo.js";

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
    include: { product: { select: { id: true, sku: true, nombre: true, precio: true, stock: true } } },
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
    nombre: combo.nombre,
    frase: combo.frase,
    porcentaje: combo.porcentaje,
    activo: combo.activo,
    vigencia: combo.vigencia,
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

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
