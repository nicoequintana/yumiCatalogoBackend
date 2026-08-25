import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { esRequestDeAdmin } from "../middlewares/auth.middleware.js";

/**
 * Tope de anuncios cargados. La cinta los muestra a todos en un mismo desfile:
 * con demasiados, un mensaje tarda minutos en volver a pasar y deja de cumplir
 * su función. El límite es de producto, no técnico.
 */
export const MAX_ANUNCIOS = 20;

/**
 * Largo máximo del texto. **Es el mismo valor que `@db.NVarChar(200)` en el
 * esquema**, y no por casualidad: sin esta validación un texto más largo llega
 * a la base y explota como `P2000`, que el error handler traduce a un 400
 * genérico ("valor demasiado largo") sin decir qué campo ni cuál es el límite.
 * Validar acá permite un mensaje que sí lo dice.
 */
export const LARGO_MAX_ANUNCIO = 200;

function mapAnuncio(anuncio) {
  return {
    id: anuncio.id,
    texto: anuncio.texto,
    activo: anuncio.activo,
    orden: anuncio.orden,
  };
}

/**
 * `orden` asc con desempate por `id`: dos anuncios pueden compartir `orden`
 * (el default es 0, así que dos altas concurrentes lo hacen), y sin el segundo
 * criterio el motor puede devolverlos en cualquier orden entre request y
 * request — la cinta cambiaría de secuencia sola al recargar.
 */
const ORDEN_LISTADO = [{ orden: "asc" }, { id: "asc" }];

function parsearTexto(body) {
  const texto = typeof body?.texto === "string" ? body.texto.trim() : "";
  if (!texto) throw httpError(400, "El texto del anuncio es obligatorio.");
  if (texto.length > LARGO_MAX_ANUNCIO) {
    throw httpError(400, `El texto no puede superar los ${LARGO_MAX_ANUNCIO} caracteres.`);
  }
  return texto;
}

/**
 * `activo` es opcional en las dos mutaciones, y ausente NO significa `false`:
 * significa "no lo toques". Interpretar un body sin la clave como una baja
 * apagaría el anuncio en cualquier actualización que solo cambie el texto.
 */
function parsearActivo(body) {
  if (body?.activo === undefined) return undefined;
  if (typeof body.activo !== "boolean") throw httpError(400, "`activo` debe ser un booleano.");
  return body.activo;
}

function idDeParams(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(404, "Anuncio no encontrado.");
  return id;
}

/**
 * `GET /anuncios`.
 *
 * La ruta lleva `authOpcional`, así que el mismo endpoint sirve al catálogo
 * público y al panel. **Quién ve los inactivos lo decide el TOKEN, nunca la
 * querystring** — mismo criterio que `GET /products`: un `?admin=1` que
 * cambiara la respuesta sería una llave maestra, porque el frontend público lo
 * lleva escrito en un bundle que cualquiera lee.
 *
 * El `take` es una red de seguridad, no el límite real: el tope se aplica al
 * crear, con un mensaje que lo explica. Existe para que la consulta pública no
 * sea ilimitada si alguna vez entran filas por otra vía.
 */
export async function listar(req, res, next) {
  try {
    const esAdmin = esRequestDeAdmin(req);
    const anuncios = await prisma.anuncio.findMany({
      where: esAdmin ? undefined : { activo: true },
      orderBy: ORDEN_LISTADO,
      take: MAX_ANUNCIOS,
    });
    res.json(anuncios.map(mapAnuncio));
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  try {
    const texto = parsearTexto(req.body);
    const activo = parsearActivo(req.body) ?? true;

    const total = await prisma.anuncio.count();
    if (total >= MAX_ANUNCIOS) {
      throw httpError(
        400,
        `No se pueden cargar más de ${MAX_ANUNCIOS} anuncios. Borrá o desactivá alguno antes de agregar otro.`,
      );
    }

    // El anuncio nuevo va al final de la cinta. `orden` arranca en 0, así que
    // sobre una tabla vacía `_max.orden` es null y el `?? -1` deja el primero
    // en 0 — sin eso, `null + 1` da 1 y el primer anuncio nacería en la
    // posición 1, dejando un hueco delante.
    const { _max } = await prisma.anuncio.aggregate({ _max: { orden: true } });
    const orden = (_max.orden ?? -1) + 1;

    const anuncio = await prisma.anuncio.create({ data: { texto, activo, orden } });

    // Fire-and-forget: la respuesta no espera el insert de auditoría.
    logAudit(req, {
      accion: "CREAR",
      entidad: "Anuncio",
      entidadId: anuncio.id,
      detalle: { texto: anuncio.texto, activo: anuncio.activo },
    });

    res.status(201).json(mapAnuncio(anuncio));
  } catch (err) {
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = idDeParams(req);
    const actual = await prisma.anuncio.findUnique({ where: { id } });
    if (!actual) throw httpError(404, "Anuncio no encontrado.");

    // El texto solo se valida si viene: así el panel puede mandar `{activo}`
    // suelto para el interruptor de la fila, sin reenviar el texto entero.
    const texto = req.body?.texto === undefined ? undefined : parsearTexto(req.body);
    const activo = parsearActivo(req.body);
    if (texto === undefined && activo === undefined) {
      throw httpError(400, "No hay nada que actualizar.");
    }

    const anuncio = await prisma.anuncio.update({ where: { id }, data: { texto, activo } });

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Anuncio",
      entidadId: anuncio.id,
      detalle: {
        anterior: { texto: actual.texto, activo: actual.activo },
        nuevo: { texto: anuncio.texto, activo: anuncio.activo },
      },
    });

    res.json(mapAnuncio(anuncio));
  } catch (err) {
    next(err);
  }
}

export async function eliminar(req, res, next) {
  try {
    const id = idDeParams(req);
    const anuncio = await prisma.anuncio.findUnique({ where: { id } });
    if (!anuncio) throw httpError(404, "Anuncio no encontrado.");

    await prisma.anuncio.delete({ where: { id } });

    logAudit(req, {
      accion: "ELIMINAR",
      entidad: "Anuncio",
      entidadId: id,
      detalle: { texto: anuncio.texto },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * `PUT /anuncios/orden` — reescribe la secuencia completa.
 *
 * **Esta ruta se declara ANTES de `PUT /anuncios/:id`**, si no Express matchea
 * "orden" como un id (el mismo pisotón que evitan `/products/import` y
 * `/products/eliminar-masivo`).
 *
 * Recibe la lista ordenada de ids y asigna `orden = posición`. Va en
 * transacción: una secuencia aplicada a medias deja la cinta en un orden que no
 * es ni el viejo ni el nuevo.
 */
export async function reordenar(req, res, next) {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw httpError(400, "Enviá la lista de ids en el orden deseado.");
    }
    if (!ids.every((id) => Number.isInteger(id))) {
      throw httpError(400, "Los ids deben ser números enteros.");
    }
    if (new Set(ids).size !== ids.length) {
      throw httpError(400, "La lista de ids tiene repetidos.");
    }

    // Se verifica que existan TODOS antes de escribir. Sin esto, un panel con
    // datos viejos (un anuncio que otro admin borró) reordenaría los demás
    // igual y el resultado sería un orden que nadie pidió.
    const existentes = await prisma.anuncio.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (existentes.length !== ids.length) {
      throw httpError(400, "Alguno de los anuncios ya no existe. Recargá la pantalla.");
    }

    await prisma.$transaction(
      ids.map((id, indice) => prisma.anuncio.update({ where: { id }, data: { orden: indice } })),
    );

    const anuncios = await prisma.anuncio.findMany({ orderBy: ORDEN_LISTADO });

    logAudit(req, {
      accion: "REORDENAR",
      entidad: "Anuncio",
      detalle: { ids },
    });

    res.json(anuncios.map(mapAnuncio));
  } catch (err) {
    next(err);
  }
}
