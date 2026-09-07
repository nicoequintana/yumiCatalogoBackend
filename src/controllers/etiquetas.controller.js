import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import {
  COLORES_ETIQUETA,
  esColorEtiquetaValido,
  resolverColorEtiqueta,
} from "../lib/coloresEtiqueta.js";

/**
 * Largo máximo del nombre. **Es el mismo valor que `@db.NVarChar(40)` en el
 * esquema**: sin esta validación un nombre más largo llega a la base y explota
 * como `P2000`, que el error handler traduce a un 400 genérico sin decir qué
 * campo ni cuál es el límite. Mismo criterio que `LARGO_MAX_ANUNCIO`.
 *
 * Espeja el `maxLength` y el contador de `AdminEtiquetas.jsx` — sync manual
 * entre repos, con la autoridad de este lado.
 */
export const LARGO_MAX_ETIQUETA = 40;

const ORDEN_LISTADO = [{ nombre: "asc" }, { id: "asc" }];

/**
 * Emite el color YA RESUELTO a canales. El frontend no tiene copia de la
 * paleta: pinta con `style` inline lo que reciba. Regla 1 de la metodología —
 * el dato derivado viaja en la respuesta.
 *
 * `colorFondo: null` no es un error: significa "pintá como siempre", y cada
 * superficie cae a su token por defecto.
 */
function mapFilaEtiqueta(etiqueta) {
  const color = resolverColorEtiqueta(etiqueta.color);
  return {
    id: etiqueta.id,
    nombre: etiqueta.nombre,
    color: etiqueta.color ?? null,
    colorFondo: color?.fondo ?? null,
    colorTexto: color?.texto ?? null,
    cantidadProductos: etiqueta._count?.productos ?? 0,
  };
}

function parsearNombre(body, { obligatorio }) {
  if (body?.nombre === undefined) {
    if (obligatorio) throw httpError(400, "El nombre de la etiqueta es obligatorio.");
    return undefined;
  }
  const nombre = typeof body.nombre === "string" ? body.nombre.trim() : "";
  if (!nombre) throw httpError(400, "El nombre de la etiqueta es obligatorio.");
  if (nombre.length > LARGO_MAX_ETIQUETA) {
    throw httpError(400, `El nombre no puede superar los ${LARGO_MAX_ETIQUETA} caracteres.`);
  }
  return nombre;
}

/**
 * `color` ausente significa "no lo toques"; `null` explícito significa "sacale
 * el color y volvé al de siempre". Son dos cosas distintas y por eso no se
 * colapsan con `??`.
 */
function parsearColor(body) {
  if (body?.color === undefined) return undefined;
  if (body.color === null) return null;
  if (!esColorEtiquetaValido(body.color)) {
    throw httpError(400, "El color elegido no pertenece a la paleta de etiquetas.");
  }
  return body.color;
}

function idDeParams(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(404, "Etiqueta no encontrada.");
  return id;
}

/** El P2002 de `nombre @unique` traducido a algo que el admin pueda accionar. */
function traducirNombreRepetido(err, nombre) {
  if (err?.code === "P2002") {
    return httpError(400, `Ya existe una etiqueta llamada "${nombre}".`);
  }
  return err;
}

export async function listar(_req, res, next) {
  try {
    const etiquetas = await prisma.etiqueta.findMany({
      orderBy: ORDEN_LISTADO,
      include: { _count: { select: { productos: true } } },
    });
    res.json(etiquetas.map(mapFilaEtiqueta));
  } catch (err) {
    next(err);
  }
}

/**
 * `GET /etiquetas/opciones` — las 20 muestras para el selector del panel.
 *
 * **La fuente es el backend: el frontend no tiene copia**, mismo criterio que
 * `GET /ordenes/estados` y `GET /campanias/opciones`. Es lo que mantiene la
 * paleta en una sola casa.
 */
export async function opciones(_req, res, next) {
  try {
    res.json({ colores: COLORES_ETIQUETA });
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  const nombre = (() => {
    try {
      return parsearNombre(req.body, { obligatorio: true });
    } catch (err) {
      next(err);
      return null;
    }
  })();
  if (nombre === null) return;

  try {
    const color = parsearColor(req.body) ?? null;
    const etiqueta = await prisma.etiqueta.create({ data: { nombre, color } });

    logAudit(req, {
      accion: "CREAR",
      entidad: "Etiqueta",
      entidadId: etiqueta.id,
      detalle: { nombre: etiqueta.nombre, color: etiqueta.color },
    });

    res.status(201).json(mapFilaEtiqueta(etiqueta));
  } catch (err) {
    next(traducirNombreRepetido(err, req.body?.nombre));
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = idDeParams(req);
    const anterior = await prisma.etiqueta.findUnique({ where: { id } });
    if (!anterior) throw httpError(404, "Etiqueta no encontrada.");

    const nombre = parsearNombre(req.body, { obligatorio: false });
    const color = parsearColor(req.body);
    if (nombre === undefined && color === undefined) {
      throw httpError(400, "No hay nada que actualizar: mandá `nombre` y/o `color`.");
    }

    let etiqueta;
    try {
      etiqueta = await prisma.etiqueta.update({ where: { id }, data: { nombre, color } });
    } catch (err) {
      throw traducirNombreRepetido(err, nombre);
    }

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Etiqueta",
      entidadId: id,
      detalle: {
        anterior: { nombre: anterior.nombre, color: anterior.color },
        nuevo: { nombre: etiqueta.nombre, color: etiqueta.color },
      },
    });

    res.json(mapFilaEtiqueta(etiqueta));
  } catch (err) {
    next(err);
  }
}

/**
 * Borrado GUARDADO, copia del criterio de `categorias.controller.js`: si algún
 * producto la usa, 400 con el conteo en el mensaje. La FK es `NO ACTION`, así
 * que sin esta guarda el borrado explotaría como `P2003` → 500 opaco, y el
 * admin leería "error del servidor" en vez de "cuatro productos la usan".
 */
export async function eliminar(req, res, next) {
  try {
    const id = idDeParams(req);
    const etiqueta = await prisma.etiqueta.findUnique({ where: { id } });
    if (!etiqueta) throw httpError(404, "Etiqueta no encontrada.");

    const cantidadProductos = await prisma.product.count({ where: { etiquetaId: id } });
    if (cantidadProductos > 0) {
      throw httpError(
        400,
        `No se puede eliminar: ${cantidadProductos} producto${cantidadProductos === 1 ? "" : "s"} usa${cantidadProductos === 1 ? "" : "n"} esta etiqueta.`,
      );
    }

    await prisma.etiqueta.delete({ where: { id } });

    logAudit(req, {
      accion: "ELIMINAR",
      entidad: "Etiqueta",
      entidadId: id,
      detalle: { nombre: etiqueta.nombre },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
