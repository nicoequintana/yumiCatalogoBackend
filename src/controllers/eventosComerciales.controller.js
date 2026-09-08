import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { truncarTexto } from "../lib/limitesTexto.js";
import { validarEventoComercial } from "../lib/eventosComerciales.js";

/**
 * Impresiones y clicks del cartel y del slide, para campañas y promociones.
 *
 * Es una ruta PROPIA y no una ampliación de `POST /eventos`, a propósito.
 * `TIPOS_VALIDOS` de `eventos.controller.js` es un subconjunto de dos tipos
 * que existe para ser corto: cada vez que se agranda es más difícil defender
 * la siguiente ampliación. Una ruta propia gana además dos cosas concretas:
 * el id viaja en la URL y se valida contra la base ANTES de escribir, y el
 * límite de frecuencia se calibra al volumen de impresiones, que no es el de
 * los clicks.
 *
 * Lo que se valida: que el cuerpo tenga forma (`validarEventoComercial`) y
 * que la referencia EXISTA (un `findUnique` por PK, que no cuesta nada).
 *
 * Lo que NO se valida, a propósito: la vigencia. Para una promoción exige el
 * `where` completo de `condicionPromocionVigente` —dos `OR` y dos joins— por
 * cada impresión, en un endpoint público. Y no evita ningún daño: la lectura
 * acota al período de la campaña, así que un evento de una campaña vencida
 * cae fuera de su rango y no aparece, y uno de una programada cae antes de su
 * inicio. Hay un test que fija que una FINALIZADA se acepta igual, para que
 * nadie sume esa consulta "por prolijidad".
 */

/** @param {unknown} raw */
function parsearId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError(400, "El id no es válido.");
  }
  return id;
}

/**
 * @param {"campania" | "promocion"} referencia
 */
async function crear(req, res, next, referencia) {
  try {
    const id = parsearId(req.params?.id);
    const { tipo, origen, destino } = validarEventoComercial(req.body);

    // Una promoción NO tiene cartel: `TIPOS_DESTINO_CTA` no incluye
    // `PROMOCION`, así que ningún modal apunta nunca a una y la Parte 2 solo
    // emite `BANNER` para promociones. Aceptar `MODAL` acá dejaba fabricar
    // gratis, desde afuera y sin login, `impresiones.MODAL` de una superficie
    // que no existe. La validación es de FORMA (depende del par
    // referencia/origen, no del estado de la base), así que va antes de
    // cualquier consulta.
    if (referencia === "promocion" && origen === "MODAL") {
      throw httpError(400, "Una promoción no tiene cartel: su único origen es BANNER.");
    }

    // Solo la existencia, con el select mínimo: es lo que impide guardar ids
    // inventados sin pagar una consulta cara por impresión.
    const existe =
      referencia === "campania"
        ? await prisma.campania.findUnique({ where: { id }, select: { id: true } })
        : await prisma.promocion.findUnique({ where: { id }, select: { id: true } });

    if (!existe) {
      throw httpError(
        404,
        referencia === "campania" ? "La campaña no existe." : "La promoción no existe.",
      );
    }

    const evento = await prisma.eventoTrafico.create({
      data: {
        tipo,
        origen,
        destino,
        // Mutuamente excluyentes, el otro SIEMPRE en null explícito: es el
        // contrato de los `slides` de /campanias/activas, y un `undefined`
        // acá haría que Prisma omita la columna en vez de escribir null.
        campaniaId: referencia === "campania" ? id : null,
        promocionId: referencia === "promocion" ? id : null,
        productId: null,
        // Recortados al largo de su columna, como en eventos.controller.js:
        // un header más largo producía un P2000 -> 500 público.
        referrer: truncarTexto(req.get("Referer")),
        userAgent: truncarTexto(req.get("User-Agent")),
      },
    });

    res.status(201).json({ id: evento.id });
  } catch (err) {
    next(err);
  }
}

export function crearDeCampania(req, res, next) {
  return crear(req, res, next, "campania");
}

export function crearDePromocion(req, res, next) {
  return crear(req, res, next, "promocion");
}
