import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { exigirIdsExistentes } from "../lib/idsExistentes.js";
import { urlDeFoto } from "../lib/fotos.js";
import { esRequestDeAdmin } from "../middlewares/auth.middleware.js";
import { LARGO_MAX_TEXTO } from "../lib/limitesTexto.js";
import { ALLOWED_PHOTO_MIMES } from "../lib/limitesMedios.js";
import { contenidoCoincideConMime } from "../lib/magicBytes.js";
import { subirArchivo, eliminarArchivo } from "../services/cloudinary.service.js";
import { claveDiaArgentino, diasHastaClave, inicioDelDiaArgentino } from "../lib/horarioArgentino.js";
import { rutaCategoria, rutaProducto } from "../lib/slug.js";
import { condicionProductoConDescuento } from "../lib/precioEfectivo.js";
import {
  COLOR_SLIDE_POR_DEFECTO,
  COLORES_SLIDE,
  CTA_TEXTO_POR_DEFECTO,
  ESTADOS_CAMPANIA,
  TIPOS_CAMPANIA,
  TIPOS_DESTINO_CTA,
  elegirPorPrioridad,
  listaDeColoresSlide,
  listaDeDestinosCta,
  listaDeEstadosCampania,
  listaDeTipos,
  resolverEstadoCampania,
} from "../lib/campanias.js";

/**
 * Largo máximo del nombre. **Es el mismo valor que `@db.NVarChar(120)` en el
 * esquema**, por el mismo motivo que `LARGO_MAX_ANUNCIO`: sin esta validación
 * el texto llega a la base y explota como `P2000`, que el error handler
 * traduce a un 400 genérico sin decir qué campo ni cuál es el límite.
 */
export const LARGO_MAX_NOMBRE = 120;

/**
 * Tope de productos en la vitrina de una campaña. De producto, no técnico —
 * mismo criterio y mismo número que `MAX_ITEMS_PROMOCION`: una vitrina de más
 * de 200 productos no es una selección, es el catálogo entero.
 */
export const MAX_PRODUCTOS_CAMPANIA = 200;

/** Espejan `@db.NVarChar(...)` de las columnas del modal, mismo criterio. */
export const LARGO_MAX_MODAL_TITULO = 120;
export const LARGO_MAX_MODAL_CTA = 60;

/** Espejan `@db.NVarChar(...)` de las columnas del banner, mismo criterio. */
export const LARGO_MAX_BANNER_TITULO = 120;
/**
 * 200 y no `LARGO_MAX_TEXTO` (1000) como el cartel: el banner es una franja
 * dentro del flujo de la home, no una tarjeta a pantalla completa.
 */
export const LARGO_MAX_BANNER_TEXTO = 200;
export const LARGO_MAX_BANNER_CTA = 60;

/**
 * La ruta a la que cae CUALQUIER destino que ya no se puede resolver.
 *
 * Es el catálogo entero: la pantalla que siempre existe y que nunca está vacía
 * por culpa de un dato borrado. Un botón que lleva de más es infinitamente mejor
 * que uno que lleva a un 404 o a una grilla en blanco.
 */
const DESTINO_POR_DEFECTO = "/coleccion";

/** Los dos destinos que apuntan a UNA fila concreta y por eso exigen su id. */
const DESTINOS_CON_REFERENCIA = ["CATEGORIA", "PRODUCTO"];

/** Formato de fecha que acepta la API: día argentino, sin hora. */
const SOLO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Orden del listado del panel: las que arrancan más tarde primero, con
 * desempate por `id`.
 *
 * El desempate no es decorativo. Dos campañas que arrancan el mismo día son
 * frecuentes (una estacional y una fecha especial adentro), y sin el segundo
 * criterio el motor puede devolverlas en distinto orden entre dos consultas:
 * al paginar, una fila aparecería dos veces o ninguna.
 */
const ORDEN_LISTADO = [{ desde: "desc" }, { id: "desc" }];

/**
 * La forma que ve el PANEL. Incluye el estado ya resuelto para que ninguna
 * pantalla vuelva a calcularlo — es la regla 1 de la metodología aplicada al
 * dato derivado más importante de este módulo.
 *
 * Las fechas salen como `"YYYY-MM-DD"` y no como ISO completo a propósito:
 * `formatFecha` del frontend detecta ese formato y lo descompone a mano
 * justamente para NO pasarlo por `new Date()`, que en Argentina lo corre al día
 * anterior. Mandar un ISO con hora desactivaría esa protección.
 */
function mapCampania(campania, ahora) {
  const estado = resolverEstadoCampania(campania, ahora);

  return {
    id: campania.id,
    nombre: campania.nombre,
    descripcion: campania.descripcion,
    tipo: campania.tipo,
    estado: campania.estado,
    desde: claveDiaArgentino(campania.desde),
    hasta: claveDiaArgentino(campania.hasta),
    prioridad: campania.prioridad,
    estadoTemporal: estado.temporal,
    activa: estado.activa,
    etiquetaEstado: estado.etiquetaEstado,
    etiquetaTemporal: estado.etiquetaTemporal,
    doodleUrl: campania.doodleUrl,
    doodleEnCatalogo: campania.doodleEnCatalogo,
    doodleEnAdmin: campania.doodleEnAdmin,
    modalActivo: campania.modalActivo,
    modalTitulo: campania.modalTitulo,
    modalTexto: campania.modalTexto,
    modalCtaTexto: campania.modalCtaTexto,
    // El PANEL recibe la INTENCIÓN cruda (tipo + id), que es lo que el
    // formulario edita con dos `<select>`. El CATÁLOGO recibe la ruta ya
    // resuelta (`aModalPublico`). Son dos formas del mismo dato a propósito.
    modalCtaTipo: campania.modalCtaTipo,
    modalCtaReferenciaId: campania.modalCtaReferenciaId,
    modalFechaObjetivo: campania.modalFechaObjetivo
      ? claveDiaArgentino(campania.modalFechaObjetivo)
      : null,
    bannerEnHome: campania.bannerEnHome,
    bannerTitulo: campania.bannerTitulo,
    bannerTexto: campania.bannerTexto,
    bannerCtaTexto: campania.bannerCtaTexto,
    bannerColor: campania.bannerColor,
  };
}

function parsearNombre(body) {
  const nombre = typeof body?.nombre === "string" ? body.nombre.trim() : "";
  if (!nombre) throw httpError(400, "El nombre de la campaña es obligatorio.");
  if (nombre.length > LARGO_MAX_NOMBRE) {
    throw httpError(400, `El nombre no puede superar los ${LARGO_MAX_NOMBRE} caracteres.`);
  }
  return nombre;
}

/**
 * La descripción es opcional y una cadena vacía significa "sin descripción",
 * no una cadena vacía guardada: así el panel puede mandar el campo siempre, sin
 * ramificar según si el admin escribió algo.
 */
function parsearDescripcion(body) {
  if (body?.descripcion === undefined || body.descripcion === null) return null;
  if (typeof body.descripcion !== "string") {
    throw httpError(400, "La descripción debe ser texto.");
  }
  const descripcion = body.descripcion.trim();
  if (descripcion.length > LARGO_MAX_TEXTO) {
    throw httpError(400, `La descripción no puede superar los ${LARGO_MAX_TEXTO} caracteres.`);
  }
  return descripcion || null;
}

function parsearTipo(body) {
  const tipo = body?.tipo;
  if (!TIPOS_CAMPANIA.includes(tipo)) {
    throw httpError(400, `El tipo debe ser uno de: ${TIPOS_CAMPANIA.join(", ")}.`);
  }
  return tipo;
}

function parsearEstado(valor) {
  if (!ESTADOS_CAMPANIA.includes(valor)) {
    throw httpError(400, `El estado debe ser uno de: ${ESTADOS_CAMPANIA.join(", ")}.`);
  }
  return valor;
}

/**
 * `"YYYY-MM-DD"` → la medianoche ARGENTINA de ese día.
 *
 * El formato se exige con regex antes de tocar `Date`: `new Date("10/09/2026")`
 * no falla, devuelve el 9 de octubre. Aceptar cualquier cosa que `Date` sepa
 * parsear haría que un tipeo con formato argentino se guarde como una fecha
 * plausible y equivocada, sin ningún error.
 */
function parsearFecha(valor, campo) {
  if (typeof valor !== "string" || !SOLO_FECHA.test(valor)) {
    throw httpError(400, `La fecha de ${campo} debe tener el formato AAAA-MM-DD.`);
  }
  const fecha = inicioDelDiaArgentino(valor);
  if (fecha === null) throw httpError(400, `La fecha de ${campo} no es válida.`);
  return fecha;
}

/**
 * El rango completo. Inicio igual a fin es válido y es el caso de una fecha
 * puntual (Navidad): la campaña vale ese día entero.
 */
function parsearRango(body) {
  const desde = parsearFecha(body?.desde, "inicio");
  const hasta = parsearFecha(body?.hasta, "fin");
  if (desde.getTime() > hasta.getTime()) {
    throw httpError(400, "La fecha de inicio no puede ser posterior a la de fin.");
  }
  return { desde, hasta };
}

function parsearPrioridad(body) {
  if (body?.prioridad === undefined) return 0;
  if (!Number.isInteger(body.prioridad)) {
    throw httpError(400, "La prioridad debe ser un número entero.");
  }
  return body.prioridad;
}

/**
 * Los dos flags de dónde se muestra el Doodle.
 *
 * Una clave AUSENTE significa "no la toques" y cae al valor que se le pase —
 * el default en el alta, el valor actual en la edición. Mismo criterio que
 * `parsearActivo` en `anuncios.controller.js`: interpretar un body sin la clave
 * como `false` apagaría el flag en cualquier edición que solo cambie el nombre.
 */
function parsearFlagDoodle(body, campo, porDefecto) {
  if (body?.[campo] === undefined) return porDefecto;
  if (typeof body[campo] !== "boolean") {
    throw httpError(400, `\`${campo}\` debe ser un booleano.`);
  }
  return body[campo];
}

/** Texto opcional acotado: vacío degrada a `null`, largo de más es 400. */
function parsearTextoOpcional(valor, campo, largoMax) {
  if (valor === undefined || valor === null) return null;
  if (typeof valor !== "string") throw httpError(400, `\`${campo}\` debe ser texto.`);
  const texto = valor.trim();
  if (texto.length > largoMax) {
    throw httpError(400, `\`${campo}\` no puede superar los ${largoMax} caracteres.`);
  }
  return texto || null;
}

/**
 * A DÓNDE lleva el botón, como intención y no como ruta.
 *
 * Clave ausente = "no la toques", igual que `parsearFlagDoodle`: un PUT que solo
 * cambia el nombre no puede quedarse sin botón. `null` explícito sí lo quita.
 */
function parsearTipoDestinoCta(body, actual) {
  if (body?.modalCtaTipo === undefined) return actual?.modalCtaTipo ?? null;
  if (body.modalCtaTipo === null) return null;
  if (!TIPOS_DESTINO_CTA.includes(body.modalCtaTipo)) {
    throw httpError(400, `El destino debe ser uno de: ${TIPOS_DESTINO_CTA.join(", ")}.`);
  }
  return body.modalCtaTipo;
}

/** Ídem para el id al que apunta. Misma semántica de clave ausente. */
function parsearReferenciaCta(body, actual) {
  if (body?.modalCtaReferenciaId === undefined) return actual?.modalCtaReferenciaId ?? null;
  if (body.modalCtaReferenciaId === null) return null;
  if (!Number.isInteger(body.modalCtaReferenciaId) || body.modalCtaReferenciaId <= 0) {
    throw httpError(400, "La referencia del destino debe ser un id entero positivo.");
  }
  return body.modalCtaReferenciaId;
}

/**
 * Todo el bloque del modal, validado como una unidad.
 *
 * Se valida junto y no campo por campo porque las reglas son CRUZADAS: un modal
 * prendido exige título, un botón con texto exige destino, y un destino a una
 * categoría o a un producto exige a CUÁL. Un botón que no lleva a ningún lado, o
 * un cartel sin título, son cosas que el panel puede guardar sin querer y que
 * después ve todo el mundo.
 *
 * Con el modal APAGADO no se exige nada: se pueden dejar los textos a medio
 * escribir y prenderlo después.
 *
 * Es SÍNCRONA: acá solo se valida la FORMA. Que la categoría o el producto
 * existan de verdad lo verifica `exigirReferenciaCta`, que sí toca la base.
 */
function parsearModal(body, actual = null) {
  const activo = parsearFlagDoodle(body, "modalActivo", actual?.modalActivo ?? false);

  const titulo = parsearTextoOpcional(body?.modalTitulo, "modalTitulo", LARGO_MAX_MODAL_TITULO);
  const texto = parsearTextoOpcional(body?.modalTexto, "modalTexto", LARGO_MAX_TEXTO);
  const ctaTexto = parsearTextoOpcional(body?.modalCtaTexto, "modalCtaTexto", LARGO_MAX_MODAL_CTA);

  const ctaTipo = parsearTipoDestinoCta(body, actual);
  // Con CAMPANIA, CATALOGO o sin destino, una referencia no significa nada: se
  // fuerza a `null` en vez de guardarla. Dejarla escrita haría que volver a
  // elegir CATEGORIA más adelante resucite un id viejo que nadie confirmó.
  const ctaReferenciaId = DESTINOS_CON_REFERENCIA.includes(ctaTipo)
    ? parsearReferenciaCta(body, actual)
    : null;

  if (activo && !titulo) {
    throw httpError(400, "Un modal activo necesita un título.");
  }
  if (ctaTexto !== null && ctaTipo === null) {
    throw httpError(400, "El botón tiene texto pero no lleva a ningún lado.");
  }
  if (DESTINOS_CON_REFERENCIA.includes(ctaTipo) && ctaReferenciaId === null) {
    throw httpError(
      400,
      ctaTipo === "CATEGORIA"
        ? "Elegí la categoría a la que lleva el botón."
        : "Elegí el producto al que lleva el botón.",
    );
  }

  let fechaObjetivo = null;
  if (body?.modalFechaObjetivo !== undefined && body.modalFechaObjetivo !== null) {
    fechaObjetivo = parsearFecha(body.modalFechaObjetivo, "objetivo del contador");
  } else if (body?.modalFechaObjetivo === undefined) {
    fechaObjetivo = actual?.modalFechaObjetivo ?? null;
  }

  return {
    modalActivo: activo,
    modalTitulo: titulo,
    modalTexto: texto,
    modalCtaTexto: ctaTexto,
    modalCtaTipo: ctaTipo,
    modalCtaReferenciaId: ctaReferenciaId,
    modalFechaObjetivo: fechaObjetivo,
  };
}

/**
 * El marcador del contador. Vive en el cartel, que tiene `modalFechaObjetivo`;
 * el banner no cuenta días, así que acá es un error de entrada y no un texto.
 */
const MARCADOR_DIAS = /\{dias\}/i;

/** Rechaza el marcador del contador en un campo del banner. */
function exigirSinMarcadorDeDias(texto, campo) {
  if (texto && MARCADOR_DIAS.test(texto)) {
    throw httpError(
      400,
      `El contador \`{dias}\` es del cartel, no del banner. Sacalo de \`${campo}\` o escribí los días a mano.`,
    );
  }
}

/**
 * El bloque del banner de la home, validado como una unidad.
 *
 * Mismo criterio cruzado que `parsearModal`: apagado no se exige nada —se
 * pueden dejar los textos a medio escribir y prenderlo después—, y prendido se
 * exige lo mínimo para que la franja no salga rota.
 *
 * **El destino NO se parsea acá.** Lo emite `parsearModal`, y es el de la
 * CAMPAÑA: `modalCtaTipo` / `modalCtaReferenciaId` los comparten las dos
 * superficies. Duplicarlos serían dos verdades que se desincronizan sin que
 * nada falle. Consecuencia: este parser mira `modalCtaTipo` para saber si hay
 * botón, pero nunca lo escribe.
 */
function parsearBanner(body, actual = null, ctaTipo = null) {
  const enHome = parsearFlagDoodle(body, "bannerEnHome", actual?.bannerEnHome ?? false);

  const titulo = parsearTextoOpcional(body?.bannerTitulo, "bannerTitulo", LARGO_MAX_BANNER_TITULO);
  const texto = parsearTextoOpcional(body?.bannerTexto, "bannerTexto", LARGO_MAX_BANNER_TEXTO);
  const ctaTexto = parsearTextoOpcional(
    body?.bannerCtaTexto,
    "bannerCtaTexto",
    LARGO_MAX_BANNER_CTA,
  );

  exigirSinMarcadorDeDias(titulo, "bannerTitulo");
  exigirSinMarcadorDeDias(texto, "bannerTexto");

  if (enHome && !titulo) {
    throw httpError(400, "Un banner activo necesita un título.");
  }
  if (ctaTexto !== null && ctaTipo === null) {
    throw httpError(400, "El botón del banner tiene texto pero no lleva a ningún lado.");
  }

  // Lista CERRADA, misma disciplina que `tipo`, `estado` y `modalCtaTipo`: un
  // color libre deja elegir amarillo claro con título blanco encima, sin error
  // y sin test rojo. `undefined` conserva el actual; `null` explícito vuelve al
  // default de la lib.
  let color = actual?.bannerColor ?? null;
  if (body?.bannerColor !== undefined) {
    if (body.bannerColor === null) {
      color = null;
    } else if (!COLORES_SLIDE.includes(body.bannerColor)) {
      throw httpError(400, `El color del slide debe ser uno de: ${COLORES_SLIDE.join(", ")}.`);
    } else {
      color = body.bannerColor;
    }
  }

  return {
    bannerEnHome: enHome,
    bannerTitulo: titulo,
    bannerTexto: texto,
    bannerCtaTexto: ctaTexto,
    bannerColor: color,
  };
}

/**
 * Que la categoría o el producto elegidos EXISTAN.
 *
 * Se verifica al escribir además de degradar al leer, y las dos cosas hacen
 * falta: la lectura protege al visitante de un dato que se borró DESPUÉS, y esta
 * verificación le dice al panel, en el momento, que está por publicar un cartel
 * que ya nace roto. Sin ella el admin guarda contento y el botón nunca lleva a
 * donde eligió.
 *
 * Una sola consulta como máximo, y ninguna con los destinos que no llevan
 * referencia.
 */
async function exigirReferenciaCta({ modalCtaTipo, modalCtaReferenciaId }) {
  if (modalCtaTipo === "CATEGORIA") {
    const categoria = await prisma.categoria.findUnique({
      where: { id: modalCtaReferenciaId },
      select: { id: true },
    });
    if (!categoria) throw httpError(400, "La categoría elegida ya no existe.");
    return;
  }

  if (modalCtaTipo === "PRODUCTO") {
    const producto = await prisma.product.findUnique({
      where: { id: modalCtaReferenciaId },
      select: { id: true },
    });
    if (!producto) throw httpError(400, "El producto elegido ya no existe.");
  }
}

/**
 * La INTENCIÓN guardada convertida en la RUTA de hoy.
 *
 * Acá está el motivo entero del cambio de modelo. Con la ruta persistida, el
 * botón podía apuntar a una categoría renombrada, a un producto borrado o a un
 * `?etiqueta=` que ninguna pantalla lee — y ninguno de esos tres casos daba
 * error en ningún lado. Resolviendo en la lectura, la ruta se arma contra lo que
 * existe AHORA y lo que no se puede resolver cae al catálogo.
 *
 * **Como máximo UNA consulta, y sólo cuando hace falta.** Esto corre en el único
 * endpoint público del módulo, que el catálogo pide en cada carga de página:
 * `CATALOGO` no toca la base, y ningún destino la toca dos veces.
 */
async function resolverDestinoCta(campania) {
  const referenciaId = campania.modalCtaReferenciaId;

  switch (campania.modalCtaTipo) {
    case "CATALOGO":
      return DESTINO_POR_DEFECTO;

    case "CAMPANIA": {
      // Con la vitrina vacía el botón manda al catálogo entero: llevar a una
      // grilla en blanco es peor que llevar de más. Y "vacía" es "sin nada
      // PUBLICADO" — una vitrina de productos ocultos o agotados se ve igual de
      // vacía, porque `/coleccion` filtra por las mismas dos condiciones.
      const publicados = await prisma.campaniaProducto.count({
        where: {
          campaniaId: campania.id,
          product: { visibleEnCatalogo: true, stock: { gt: 0 } },
        },
      });
      return publicados > 0 ? `${DESTINO_POR_DEFECTO}?campania=${campania.id}` : DESTINO_POR_DEFECTO;
    }

    case "CATEGORIA": {
      if (!referenciaId) return DESTINO_POR_DEFECTO;
      const categoria = await prisma.categoria.findUnique({
        where: { id: referenciaId },
        select: { nombre: true },
      });
      // ⚠️ `rutaCategoria` devuelve `null` cuando el nombre no deja slug: esa
      // ruta no lleva id, así que no hay fallback numérico al que recurrir.
      return (categoria && rutaCategoria(categoria)) || DESTINO_POR_DEFECTO;
    }

    case "PRODUCTO": {
      if (!referenciaId) return DESTINO_POR_DEFECTO;
      const producto = await prisma.product.findUnique({
        where: { id: referenciaId },
        select: { id: true, nombre: true, visibleEnCatalogo: true },
      });
      // Un producto OCULTO da 404 en su ficha pública: mandar ahí sería un
      // botón roto. Uno AGOTADO no — su ficha sigue abriendo con el badge
      // "Agotado", así que el stock no se mira acá.
      return producto?.visibleEnCatalogo ? rutaProducto(producto) : DESTINO_POR_DEFECTO;
    }

    // Sin destino no hay botón. Un valor desconocido (una fila vieja, un tipo
    // que se sacó de la lista) degrada al catálogo en vez de romper el modal.
    default:
      return campania.modalCtaTipo ? DESTINO_POR_DEFECTO : null;
  }
}

/**
 * El nombre de la categoría o el producto elegidos, para que el EDITOR pueda
 * mostrar qué se eligió.
 *
 * Sin esto el formulario tendría que traducir un id a mano —o pedir el catálogo
 * entero de categorías— para dibujar un `<select>` con la opción marcada.
 * `null` cuando no hay referencia o cuando quedó colgada: la columna no lleva FK
 * (ver el schema), así que un id que ya no existe es un caso real.
 */
async function leerReferenciaCta(campania) {
  const id = campania.modalCtaReferenciaId;
  if (!id) return null;

  if (campania.modalCtaTipo === "CATEGORIA") {
    return prisma.categoria.findUnique({ where: { id }, select: { id: true, nombre: true } });
  }
  if (campania.modalCtaTipo === "PRODUCTO") {
    return prisma.product.findUnique({ where: { id }, select: { id: true, nombre: true } });
  }
  return null;
}

/**
 * `GET /api/campanias/opciones` — los diccionarios que consume el panel.
 *
 * **Va declarada ANTES de `/:id`**, si no Express matchea "opciones" como un id.
 *
 * Existe para que el frontend NO tenga copia de las listas de tipos y estados.
 * Es el mismo criterio que `GET /ordenes/estados`, y el mismo motivo: un
 * diccionario duplicado a mano falla MUDO — se agrega un tipo, el backend lo
 * acepta, el `<select>` no lo ofrece, y ningún test se pone rojo.
 */
export function opciones(_req, res) {
  res.json({
    tipos: listaDeTipos(),
    estados: listaDeEstadosCampania(),
    destinos: listaDeDestinosCta(),
    // El default del texto del botón viaja en la respuesta y no se copia en el
    // panel: es la regla 1 de la metodología. Un placeholder hecho a mano
    // divergiría de lo que el cartel muestra, sin error y sin test rojo.
    ctaTextoPorDefecto: CTA_TEXTO_POR_DEFECTO,
    // Los colores del slide: el panel no tiene copia, mismo criterio.
    coloresSlide: listaDeColoresSlide(),
  });
}

/**
 * `GET /api/campanias/contador?hasta=YYYY-MM-DD` — cuántos días faltan.
 *
 * **Va declarada ANTES de `/:id`**, si no Express matchea "contador" como un id.
 *
 * El día lo cuenta el BACKEND y nunca el navegador: `horarioArgentino.js` es la
 * única definición de "día" del sistema. Con el cálculo del lado del panel,
 * alguien con el reloj mal puesto vería en el preview un número distinto del que
 * el cartel le muestra al visitante.
 */
export function contador(req, res, next) {
  try {
    const diasFaltantes = diasHastaClave(req.query.hasta);
    if (diasFaltantes === null) {
      throw httpError(400, "La fecha debe tener el formato AAAA-MM-DD.");
    }

    res.json({ diasFaltantes });
  } catch (err) {
    next(err);
  }
}

function idDeParams(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw httpError(404, "Campaña no encontrada.");
  return id;
}

async function buscarOFallar(id) {
  const campania = await prisma.campania.findUnique({ where: { id } });
  if (!campania) throw httpError(404, "Campaña no encontrada.");
  return campania;
}

/**
 * La forma de lectura del DETALLE: la pantalla desde la que se edita la campaña.
 *
 * Es una constante nombrada y no un `include` inline porque la comparten dos
 * caminos —`GET /:id` y la respuesta de `PUT /:id/productos`—, y divergir haría
 * que la vitrina se vea al abrir la campaña y aparezca vacía al guardarla, con
 * la suite en verde. Es la misma trampa que ya cobró `DETALLE_ORDEN_INCLUDE`.
 *
 * El LISTADO no lo usa: son N consultas para pintar una grilla.
 *
 * De la vitrina se traen sólo las columnas que el editor muestra, más la
 * portada (`take: 1` sobre `fotos`, ordenadas): la ficha completa de 200
 * productos sería traer el catálogo para dibujar una lista de chips.
 */
const DETALLE_INCLUDE = {
  promociones: { select: { promocion: { select: { id: true, nombre: true } } } },
  productos: {
    select: {
      product: {
        select: {
          id: true,
          nombre: true,
          sku: true,
          precio: true,
          visibleEnCatalogo: true,
          stock: true,
          fotos: {
            select: { id: true, url: true, cloudinaryPublicId: true },
            orderBy: { orden: "asc" },
            take: 1,
          },
        },
      },
    },
    // Por antigüedad de la asociación: el orden en que el admin fue armando la
    // vitrina. `CampaniaProducto` no tiene columna de orden a propósito —
    // sería un tercer lugar donde guardar algo que nadie pidió reordenar.
    orderBy: { createdAt: "asc" },
  },
};

async function leerDetalle(id) {
  const campania = await prisma.campania.findUnique({ where: { id }, include: DETALLE_INCLUDE });
  if (!campania) throw httpError(404, "Campaña no encontrada.");
  return campania;
}

/**
 * La campaña con sus dos relaciones: qué descuentos aplica y qué productos
 * muestra. Son dos preguntas distintas y por eso viajan en dos claves.
 *
 * `precio` sale como string: `Decimal` de Prisma serializado crudo no es un
 * número JSON que el panel pueda leer, y pasarlo a `Number` reintroduciría el
 * float en la única parte del sistema que habla de plata.
 */
async function mapDetalle(campania, ahora) {
  return {
    ...mapCampania(campania, ahora),
    // El nombre de lo que el CTA apunta. `null` explícito y no una clave
    // ausente: el editor tiene que poder distinguir "no eligió nada" de "la
    // referencia quedó colgada".
    modalCtaReferencia: (await leerReferenciaCta(campania)) ?? null,
    promociones: campania.promociones.map((a) => a.promocion),
    productos: campania.productos.map(({ product }) => ({
      id: product.id,
      nombre: product.nombre,
      sku: product.sku,
      precio: product.precio.toString(),
      // `null` explícito y no `undefined`: una clave ausente desaparece del
      // JSON y el editor no puede distinguirla de un producto sin foto.
      fotoPortada: product.fotos[0] ? urlDeFoto(product.fotos[0]) : null,
      visibleEnCatalogo: product.visibleEnCatalogo,
      stock: product.stock,
    })),
  };
}

/**
 * `GET /api/campanias/activas` — el contexto comercial del catálogo público.
 *
 * Es el ÚNICO endpoint público de este módulo y lo pide cada carga de página.
 * De ahí las dos propiedades que lo definen:
 *
 * 1. **Emite lo mínimo.** La descripción es una nota del panel y el
 *    `cloudinaryPublicId` es infraestructura: en un endpoint sin token, todo lo
 *    que viaje queda escrito en un bundle que cualquiera lee.
 * 2. **"No hay nada" es una respuesta normal**, no un 404. Sin campañas el
 *    cuerpo trae `doodle: null` y el sitio se comporta exactamente como antes
 *    de que este módulo existiera.
 *
 * La consulta filtra por índice (`estado` + `desde` + `hasta`) y el veredicto
 * final lo da `resolverEstadoCampania`: la base ACOTA, la lib DECIDE. Si algún
 * día la consulta se afloja, la lib sigue siendo la red.
 *
 * `claveDia` viaja para que el frontend no dependa del reloj del visitante
 * cuando decida si ya mostró algo hoy.
 *
 * Lleva `authOpcional`, así que el MISMO endpoint sirve al catálogo y al panel,
 * y quién ve qué lo decide el TOKEN —nunca la querystring—, igual que
 * `GET /anuncios` y `GET /products`. Con token se agrega `doodleAdmin`, que es
 * una decisión interna: una campaña puede querer marca festiva puertas adentro
 * y no de cara al cliente, y emitir ese doodle a un anónimo filtraría
 * justamente la intención que el flag expresa.
 */
function aDoodlePublico(campania) {
  return campania
    ? { url: campania.doodleUrl, campaniaId: campania.id, nombre: campania.nombre }
    : null;
}

/**
 * El modal en la forma que consume el catálogo.
 *
 * **`diasFaltantes` viaja YA RESUELTO.** El cálculo lo hace acá y no el
 * frontend por la regla 1 de la metodología, y además porque este backend es el
 * único que tiene la definición de "día" del sistema: contarlo del lado del
 * visitante haría que alguien con el reloj mal puesto viera otro número.
 *
 * `null` cuando la campaña no configuró fecha objetivo — un modal sin contador
 * es un caso legítimo, no todo cartel cuenta días. Y `null` es distinto de cero,
 * que significa "es hoy".
 *
 * El `texto` viaja CRUDO, con su marcador `{dias}` sin reemplazar: la
 * sustitución es presentación y la hace la pantalla, que es la que decide si el
 * número va resaltado. Lo que no puede salir del backend es el CÁLCULO.
 *
 * Es ASYNC porque el destino del CTA se RESUELVE contra la base (ver
 * `resolverDestinoCta`): lo que se guarda es la intención, y la ruta se arma con
 * lo que existe hoy.
 */
async function aModalPublico(campania, ahora) {
  if (!campania) return null;

  const claveObjetivo = campania.modalFechaObjetivo
    ? claveDiaArgentino(campania.modalFechaObjetivo)
    : null;

  return {
    campaniaId: campania.id,
    // El Doodle de ESTA campaña, no el del header. Los dos recursos se
    // resuelven aparte y pueden caer en campañas distintas: tomar el del logo
    // le pondría al cartel el arte de otra, sin que nada falle. `null` cuando
    // esta campaña no tiene arte — es un caso legítimo, y la clave viaja igual
    // para que la pantalla no tenga que distinguirlo de un olvido.
    doodleUrl: campania.doodleUrl ?? null,
    titulo: campania.modalTitulo,
    texto: campania.modalTexto,
    // Sin destino no hay botón, así que tampoco hay texto: emitir uno haría que
    // la pantalla dibuje un botón que no lleva a ningún lado. Con destino y sin
    // texto se usa el default, que sale de `lib/campanias.js` y no del panel.
    ctaTexto: campania.modalCtaTipo ? (campania.modalCtaTexto ?? CTA_TEXTO_POR_DEFECTO) : null,
    ctaDestino: await resolverDestinoCta(campania),
    diasFaltantes: claveObjetivo === null ? null : diasHastaClave(claveObjetivo, ahora),
  };
}

/**
 * Cuántas campañas entran al carrusel.
 *
 * Con cinco simultáneas el sexto slide no lo ve nadie, y el tope evita que una
 * carga de datos rara produzca un carrusel de veinte.
 */
const MAX_SLIDES_CAMPANIA = 5;

/**
 * Una campaña, en la forma que consume el carrusel de la home.
 *
 * Misma disciplina que `aModalPublico`: el frontend no arma rutas ni elige
 * defaults. `ctaDestino` sale del `switch` de intenciones contra lo que existe
 * HOY, y `color` viene con su default ya aplicado.
 *
 * ⚠️ **NO emite contador.** El único día objetivo que existe es
 * `modalFechaObjetivo`, que es un campo DEL CARTEL: leerlo acá ataba dos
 * superficies que el modelo declara independientes.
 *
 * ⚠️ Es `async` — el destino toca la base. Hay que resolverlo con `await` ANTES
 * del literal que va a `res.json`: una promesa dentro de un objeto se serializa
 * como `{}`, sin error y sin nada en la consola.
 */
async function aSlideCampania(campania) {
  return {
    tipo: "CAMPANIA",
    campaniaId: campania.id,
    titulo: campania.bannerTitulo,
    texto: campania.bannerTexto,
    ctaTexto: campania.modalCtaTipo ? (campania.bannerCtaTexto ?? CTA_TEXTO_POR_DEFECTO) : null,
    ctaDestino: await resolverDestinoCta(campania),
    // La pieza apaisada, si la campaña la subió. `null` es un caso legítimo y
    // la clave viaja igual para que el slide no tenga que distinguirlo de un
    // olvido: sin arte cae al molde compuesto sobre `color`.
    arteUrl: campania.bannerArteUrl ?? null,
    // El arte de SU campaña, que puede no ser la del encabezado: los dos
    // recursos se eligen aparte.
    doodleUrl: campania.doodleUrl ?? null,
    color: campania.bannerColor ?? COLOR_SLIDE_POR_DEFECTO,
  };
}

/**
 * El slide automático de ofertas, o `null` si no hay nada rebajado.
 *
 * **Lo arma el backend y no el frontend**, mismo criterio que `ctaDestino`: el
 * conteo, el plural y la ruta son datos derivados. Nunca tiene arte —no hay
 * quién se lo diseñe— así que es el caso que obliga a que el molde compuesto
 * exista y sea el piso del componente.
 */
function aSlideOfertas(total) {
  if (total <= 0) return null;

  return {
    tipo: "OFERTAS",
    campaniaId: null,
    titulo: "Ofertas de la semana",
    texto: `${total} ${total === 1 ? "producto" : "productos"} con descuento`,
    ctaTexto: "Ver ofertas",
    ctaDestino: "/coleccion?conDescuento=1",
    arteUrl: null,
    doodleUrl: null,
    color: "TINTA",
  };
}

export async function contextoActivo(req, res, next) {
  try {
    const ahora = new Date();
    const medianocheDeHoy = inicioDelDiaArgentino(claveDiaArgentino(ahora));

    const candidatas = await prisma.campania.findMany({
      where: {
        estado: "HABILITADA",
        desde: { lte: ahora },
        // `hasta` guarda la medianoche de su día: que sea >= la medianoche de
        // hoy significa "su último día es hoy o más adelante". Es la misma
        // frontera que aplica `estadoTemporal`, escrita para el índice.
        hasta: { gte: medianocheDeHoy },
      },
    });

    // La base ACOTA, la lib DECIDE: si algún día la consulta se afloja,
    // `resolverEstadoCampania` sigue siendo la red.
    const activas = candidatas.filter((c) => resolverEstadoCampania(c, ahora).activa);
    const conDoodle = activas.filter((c) => c.doodleUrl);

    // El modal es un recurso exclusivo igual que el logo —no se apilan dos
    // carteles encima del catálogo— pero se resuelve APARTE: la campaña que
    // manda el logo no tiene por qué ser la que manda el cartel.
    //
    // Se resuelve con `await` ANTES del literal y no adentro: `aModalPublico` es
    // async, y una promesa dentro de un objeto que va a `res.json` sale
    // serializada como `{}` — sin error, sin nada en la consola y con el cartel
    // vacío en el catálogo.
    const modal = await aModalPublico(
      elegirPorPrioridad(activas.filter((c) => c.modalActivo && c.modalTitulo)),
      ahora,
    );

    // Las campañas con banner completo, de mayor a menor prioridad.
    //
    // El filtro por `bannerEnHome` Y `bannerTitulo` va ANTES de ordenar, por el
    // mismo motivo por el que el modal filtra antes de `elegirPorPrioridad`: un
    // banner prendido y sin título es una franja rota.
    //
    // A diferencia del modal, acá NO se usa `elegirPorPrioridad`: el carrusel
    // muestra varias. El desempate por `id` descendente es el mismo criterio y
    // por la misma razón — sin él, dos campañas con la misma prioridad podrían
    // salir en distinto orden entre dos requests y el carrusel arrancaría en
    // una distinta en cada carga.
    const conBanner = activas
      .filter((c) => c.bannerEnHome && c.bannerTitulo)
      .sort((a, b) => b.prioridad - a.prioridad || b.id - a.id)
      .slice(0, MAX_SLIDES_CAMPANIA);

    // Cuántos productos PUBLICADOS tienen descuento vigente. Compone con las
    // guardas públicas: un producto rebajado pero oculto o agotado no cuenta,
    // porque el CTA lleva a una grilla que tampoco lo muestra.
    const totalOfertas = await prisma.product.count({
      where: {
        visibleEnCatalogo: true,
        stock: { gt: 0 },
        itemsPromocion: condicionProductoConDescuento(ahora),
      },
    });

    const slides = [
      ...(await Promise.all(conBanner.map(aSlideCampania))),
      // El automático va ÚLTIMO: las campañas son decisiones editoriales, esto
      // es un agregado del sistema.
      aSlideOfertas(totalOfertas),
    ].filter(Boolean);

    const cuerpo = {
      claveDia: claveDiaArgentino(ahora),
      doodle: aDoodlePublico(elegirPorPrioridad(conDoodle.filter((c) => c.doodleEnCatalogo))),
      modal,
      slides,
    };

    if (esRequestDeAdmin(req)) {
      cuerpo.doodleAdmin = aDoodlePublico(
        elegirPorPrioridad(conDoodle.filter((c) => c.doodleEnAdmin)),
      );
    }

    res.json(cuerpo);
  } catch (err) {
    next(err);
  }
}

/**
 * `GET /api/campanias` — el listado del panel.
 *
 * Acepta `?desde` y `?hasta` para traer solo el mes que el calendario está
 * mostrando. El filtro es de SOLAPAMIENTO, no de contención: una campaña que
 * arranca en agosto y termina en octubre tiene que aparecer al mirar
 * septiembre, porque efectivamente ocupa ese mes.
 */
export async function listar(req, res, next) {
  try {
    const ahora = new Date();
    const where = {};

    if (req.query.desde !== undefined || req.query.hasta !== undefined) {
      const desde = parsearFecha(req.query.desde, "inicio");
      const hasta = parsearFecha(req.query.hasta, "fin");
      // Solapan si empieza antes de que termine la ventana y termina después
      // de que empiece.
      where.desde = { lte: hasta };
      where.hasta = { gte: desde };
    }

    const campanias = await prisma.campania.findMany({
      where,
      orderBy: ORDEN_LISTADO,
      // Cuántos productos tiene la vitrina, contado por la base. Traer las
      // filas para contarlas en memoria serían N consultas para pintar una
      // grilla, que es exactamente lo que el listado evita.
      include: { _count: { select: { productos: true } } },
    });

    // `cantidadProductos` se agrega ACÁ y no en `mapCampania`: ese mapper lo
    // comparten crear/actualizar/cambiarEstado/duplicar/guardarDoodle, que
    // trabajan sobre una fila SIN `_count`. Emitirlo ahí haría que un
    // `PATCH /:id/estado` sobre una campaña con 5 productos devuelva 0 y la
    // pantalla muestre un cero que no es cierto.
    res.json(
      campanias.map((campania) => ({
        ...mapCampania(campania, ahora),
        cantidadProductos: campania._count.productos,
      })),
    );
  } catch (err) {
    next(err);
  }
}

export async function obtenerPorId(req, res, next) {
  try {
    const id = idDeParams(req);

    res.json(await mapDetalle(await leerDetalle(id), new Date()));
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  try {
    const modal = parsearModal(req.body);
    const datos = {
      nombre: parsearNombre(req.body),
      descripcion: parsearDescripcion(req.body),
      tipo: parsearTipo(req.body),
      estado: parsearEstado(req.body?.estado ?? "BORRADOR"),
      prioridad: parsearPrioridad(req.body),
      doodleEnCatalogo: parsearFlagDoodle(req.body, "doodleEnCatalogo", true),
      doodleEnAdmin: parsearFlagDoodle(req.body, "doodleEnAdmin", false),
      ...modal,
      ...parsearBanner(req.body, null, modal.modalCtaTipo),
      ...parsearRango(req.body),
    };

    // Después de parsear y ANTES de escribir: la referencia del CTA es lo único
    // del cuerpo que no se puede validar sin tocar la base.
    await exigirReferenciaCta(datos);

    const campania = await prisma.campania.create({ data: datos });

    // Fire-and-forget: la respuesta no espera el insert de auditoría.
    logAudit(req, {
      accion: "CREAR",
      entidad: "Campania",
      entidadId: campania.id,
      detalle: { nombre: campania.nombre, tipo: campania.tipo, estado: campania.estado },
    });

    res.status(201).json(mapCampania(campania, new Date()));
  } catch (err) {
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = idDeParams(req);
    const actual = await buscarOFallar(id);

    const modal = parsearModal(req.body, actual);
    const datos = {
      nombre: parsearNombre(req.body),
      descripcion: parsearDescripcion(req.body),
      tipo: parsearTipo(req.body),
      estado: parsearEstado(req.body?.estado ?? actual.estado),
      prioridad: parsearPrioridad(req.body),
      // Ausente = "no lo toques": cae al valor ACTUAL, no al default del alta.
      doodleEnCatalogo: parsearFlagDoodle(req.body, "doodleEnCatalogo", actual.doodleEnCatalogo),
      doodleEnAdmin: parsearFlagDoodle(req.body, "doodleEnAdmin", actual.doodleEnAdmin),
      ...modal,
      ...parsearBanner(req.body, actual, modal.modalCtaTipo),
      ...parsearRango(req.body),
    };

    await exigirReferenciaCta(datos);

    const campania = await prisma.campania.update({ where: { id }, data: datos });

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Campania",
      entidadId: id,
      detalle: {
        anterior: { nombre: actual.nombre, estado: actual.estado, prioridad: actual.prioridad },
        nuevo: { nombre: campania.nombre, estado: campania.estado, prioridad: campania.prioridad },
      },
    });

    res.json(mapCampania(campania, new Date()));
  } catch (err) {
    next(err);
  }
}

/**
 * `PATCH /api/campanias/:id/estado` — el ON/OFF manual.
 *
 * Tiene ruta propia y no pasa por `actualizar` porque es la operación que más
 * se usa y la única que el calendario dispara sin abrir el formulario: exigir
 * el cuerpo completo para apagar una campaña obligaría al panel a reenviar
 * fechas y textos que no está tocando, con el riesgo clásico de pisar con
 * datos viejos lo que otro admin acaba de cambiar.
 *
 * ⚠️ Poner una campaña en HABILITADA NO la activa si está fuera de fecha: la
 * vigencia la sigue decidiendo el período. Ver `resolverEstadoCampania`.
 */
export async function cambiarEstado(req, res, next) {
  try {
    const id = idDeParams(req);
    const actual = await buscarOFallar(id);
    const estado = parsearEstado(req.body?.estado);

    const campania = await prisma.campania.update({ where: { id }, data: { estado } });

    logAudit(req, {
      accion: "CAMBIAR_ESTADO",
      entidad: "Campania",
      entidadId: id,
      detalle: { anterior: actual.estado, nuevo: estado },
    });

    res.json(mapCampania(campania, new Date()));
  } catch (err) {
    next(err);
  }
}

/**
 * `POST /api/campanias/:id/duplicar`.
 *
 * El duplicado nace en `BORRADOR` aunque la original esté publicada: duplicar
 * es el primer paso de "armar la campaña del año que viene", y que ese borrador
 * se publique solo porque heredó el estado sería un efecto que nadie pidió.
 *
 * El Doodle se copia POR REFERENCIA — el mismo `cloudinaryPublicId`, sin volver
 * a subir el archivo. Es lo correcto (no duplica un binario idéntico en el CDN)
 * y tiene una consecuencia asumida: el borrado de una campaña solo puede
 * eliminar el archivo remoto si ninguna otra lo referencia.
 *
 * La VITRINA sí se copia: rearmar a mano la selección de productos del año
 * pasado es justamente el trabajo que duplicar viene a ahorrar.
 *
 * Las PROMOCIONES no, y es deliberado: son plata. El duplicado nace en
 * BORRADOR para armar la campaña que viene, y heredar los descuentos del año
 * pasado sería tomar por el admin una decisión que nadie pidió — mismo criterio
 * por el que el estado no se hereda.
 */
export async function duplicar(req, res, next) {
  try {
    const id = idDeParams(req);
    const original = await buscarOFallar(id);

    // En transacción: la copia y su vitrina son una sola cosa. Aplicada a
    // medias dejaría una campaña nueva con la vitrina vacía y sin ningún aviso
    // de que faltó la mitad.
    const campania = await prisma.$transaction(async (tx) => {
      // Se enumeran los campos a copiar en vez de hacer spread con delete: así,
      // una columna nueva en el modelo NO se cuela en el duplicado sin que
      // alguien lo haya decidido acá.
      const copia = await tx.campania.create({
        data: {
          nombre: `${original.nombre} (copia)`.slice(0, LARGO_MAX_NOMBRE),
          descripcion: original.descripcion,
          tipo: original.tipo,
          estado: "BORRADOR",
          desde: original.desde,
          hasta: original.hasta,
          prioridad: original.prioridad,
          doodleUrl: original.doodleUrl,
          doodleCloudinaryPublicId: original.doodleCloudinaryPublicId,
          doodleCloudinaryResourceType: original.doodleCloudinaryResourceType,
          doodleEnCatalogo: original.doodleEnCatalogo,
          doodleEnAdmin: original.doodleEnAdmin,
          modalActivo: original.modalActivo,
          modalTitulo: original.modalTitulo,
          modalTexto: original.modalTexto,
          modalCtaTexto: original.modalCtaTexto,
          modalCtaTipo: original.modalCtaTipo,
          modalCtaReferenciaId: original.modalCtaReferenciaId,
          modalFechaObjetivo: original.modalFechaObjetivo,
          bannerEnHome: original.bannerEnHome,
          bannerTitulo: original.bannerTitulo,
          bannerTexto: original.bannerTexto,
          bannerCtaTexto: original.bannerCtaTexto,
          bannerColor: original.bannerColor,
        },
      });

      const vitrina = await tx.campaniaProducto.findMany({
        where: { campaniaId: original.id },
        select: { productId: true },
      });
      if (vitrina.length > 0) {
        await tx.campaniaProducto.createMany({
          data: vitrina.map(({ productId }) => ({ campaniaId: copia.id, productId })),
        });
      }

      return copia;
    });

    logAudit(req, {
      accion: "DUPLICAR",
      entidad: "Campania",
      entidadId: campania.id,
      detalle: { origenId: original.id, nombre: campania.nombre },
    });

    res.status(201).json(mapCampania(campania, new Date()));
  } catch (err) {
    next(err);
  }
}

/**
 * Carpeta de Cloudinary de los Doodles.
 *
 * Es una FUNCIÓN y no una constante por el mismo motivo que
 * `carpetaCategorias()`: una constante congelaría el valor al importar el
 * módulo y ningún test podría verificar las dos ramas. El prefijo `test/`
 * separa los archivos de desarrollo de los de producción, que comparten una
 * única cuenta de Cloudinary.
 */
export function carpetaCampanias() {
  return process.env.NODE_ENV === "production" ? "campanias" : "test/campanias";
}

/**
 * Borra de Cloudinary el Doodle que una campaña tenía — pero SOLO si es
 * exclusivamente suyo.
 *
 * Acá está la consecuencia de que `duplicar` copie el Doodle POR REFERENCIA:
 * dos campañas pueden apuntar al mismo archivo. Un borrado ciego dejaría a la
 * otra con una URL de CDN en 404 y sin ningún error de este lado — es la misma
 * trampa que el borrado de imágenes generadas, que tiene que excluir las
 * adoptadas porque la adoptada y la foto del producto son el mismo archivo.
 *
 * Best-effort más allá de eso: si el archivo no se puede borrar queda un
 * huérfano en Cloudinary, molesto pero inofensivo. Hacer fallar la operación
 * del admin por eso sería peor.
 */
async function limpiarDoodleRemoto(campania) {
  const publicId = campania?.doodleCloudinaryPublicId;
  if (!publicId) return;

  const compartido = await prisma.campania.findMany({
    where: { doodleCloudinaryPublicId: publicId, id: { not: campania.id } },
    select: { id: true },
    take: 1,
  });
  if (compartido.length > 0) return;

  try {
    await eliminarArchivo(publicId, campania.doodleCloudinaryResourceType ?? "image");
  } catch {
    // Silencio deliberado — ver el comentario de arriba.
  }
}

/**
 * `PUT /api/campanias/:id/doodle` — sube o reemplaza el Doodle.
 *
 * Ruta propia y multipart, igual que `PUT /categorias/:id/imagen` y por el
 * mismo motivo: `PUT /campanias/:id` edita textos y fechas como JSON, y
 * volverla multipart obligaría a que TODA edición mandara un `FormData`.
 */
export async function guardarDoodle(req, res, next) {
  try {
    const id = idDeParams(req);
    if (!req.file) throw httpError(400, "No llegó ninguna imagen.");

    // Defensa en profundidad (content sniffing): el `fileFilter` de multer ya
    // validó el mimetype DECLARADO, pero ese dato lo arma el cliente y es
    // falsificable. Se confirma que los bytes reales sean los de una imagen
    // permitida antes de subir nada.
    if (
      !ALLOWED_PHOTO_MIMES.includes(req.file.mimetype) ||
      !contenidoCoincideConMime(req.file.buffer, req.file.mimetype)
    ) {
      throw httpError(400, "El contenido de la imagen no corresponde a un archivo JPG, PNG o WEBP válido.");
    }

    const actual = await buscarOFallar(id);

    const subida = await subirArchivo(req.file.buffer, "image", carpetaCampanias());

    const campania = await prisma.campania.update({
      where: { id },
      data: {
        doodleUrl: subida.url,
        doodleCloudinaryPublicId: subida.cloudinaryPublicId,
        doodleCloudinaryResourceType: subida.cloudinaryResourceType,
      },
    });

    // El anterior se borra DESPUÉS de que el nuevo quedó guardado. Al revés, un
    // fallo del update dejaría la fila apuntando a un archivo ya borrado: el
    // logo del sitio saldría roto.
    await limpiarDoodleRemoto(actual);

    logAudit(req, {
      accion: "ACTUALIZAR_DOODLE",
      entidad: "Campania",
      entidadId: id,
      detalle: { nombre: campania.nombre, doodleUrl: campania.doodleUrl },
    });

    res.json(mapCampania(campania, new Date()));
  } catch (err) {
    next(err);
  }
}

/** `DELETE /api/campanias/:id/doodle` — quita el Doodle y vuelve el logo normal. */
export async function quitarDoodle(req, res, next) {
  try {
    const id = idDeParams(req);
    const actual = await buscarOFallar(id);

    const campania = await prisma.campania.update({
      where: { id },
      data: {
        doodleUrl: null,
        doodleCloudinaryPublicId: null,
        doodleCloudinaryResourceType: null,
      },
    });

    await limpiarDoodleRemoto(actual);

    logAudit(req, {
      accion: "QUITAR_DOODLE",
      entidad: "Campania",
      entidadId: id,
      detalle: { nombre: campania.nombre },
    });

    res.json(mapCampania(campania, new Date()));
  } catch (err) {
    next(err);
  }
}

export async function eliminar(req, res, next) {
  try {
    const id = idDeParams(req);
    const campania = await buscarOFallar(id);

    await prisma.campania.delete({ where: { id } });

    // Después del delete: si la fila no se llegó a borrar, su Doodle sigue
    // siendo el de una campaña viva y borrarlo la dejaría rota.
    await limpiarDoodleRemoto(campania);

    logAudit(req, {
      accion: "ELIMINAR",
      entidad: "Campania",
      entidadId: id,
      detalle: { nombre: campania.nombre },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * `PUT /api/campanias/:id/promociones` — qué promociones aplica esta campaña.
 *
 * **De acá sale la regla más útil del módulo**: apagar la campaña apaga TODAS
 * sus promociones de una, sin desactivar nada una por una. No hay ningún estado
 * que copiar ni sincronizar — la vigencia la hereda la asociación, y por eso
 * `resolverDescuentos` mira la campaña y no una fecha guardada acá.
 *
 * Es un REEMPLAZO de la lista completa, mismo criterio que los items de una
 * promoción: el panel edita el conjunto entero, y mandar la lista vigente es la
 * forma natural de expresar "quedó así".
 *
 * ⚠️ Desasociar NO borra la promoción: sigue existiendo, con sus productos y sus
 * otras programaciones. Son dos cosas distintas y la confusión sería cara.
 */
export async function guardarPromociones(req, res, next) {
  try {
    const id = idDeParams(req);
    await buscarOFallar(id);

    const promocionIds = req.body?.promocionIds;
    if (!Array.isArray(promocionIds)) {
      throw httpError(400, "Enviá la lista de promociones en `promocionIds`.");
    }
    if (!promocionIds.every((valor) => Number.isInteger(valor) && valor > 0)) {
      throw httpError(400, "Los ids de promoción deben ser números enteros.");
    }
    if (new Set(promocionIds).size !== promocionIds.length) {
      throw httpError(400, "Hay una promoción repetida en la lista.");
    }

    await exigirIdsExistentes(prisma.promocion, promocionIds, { entidad: "Estas promociones" });

    // En transacción: aplicada a medias dejaría la campaña con la mitad de las
    // promociones viejas y la mitad de las nuevas.
    await prisma.$transaction(async (tx) => {
      await tx.campaniaPromocion.deleteMany({ where: { campaniaId: id } });
      if (promocionIds.length > 0) {
        await tx.campaniaPromocion.createMany({
          data: promocionIds.map((promocionId) => ({ campaniaId: id, promocionId })),
        });
      }
    });

    logAudit(req, {
      accion: "ACTUALIZAR_PROMOCIONES",
      entidad: "Campania",
      entidadId: id,
      detalle: { promocionIds },
    });

    const asociadas = await prisma.campaniaPromocion.findMany({
      where: { campaniaId: id },
      select: { promocionId: true },
    });
    res.json({ promocionIds: asociadas.map((a) => a.promocionId) });
  } catch (err) {
    next(err);
  }
}

/**
 * `PUT /api/campanias/:id/productos` — la VITRINA de la campaña.
 *
 * Qué productos MUESTRA la campaña, que es una pregunta distinta de qué
 * descuentos aplica. "Navidad" quiere exhibir todos los productos navideños
 * tengan o no rebaja: si listarlos exigiera una promoción, habría que inventar
 * descuentos que el negocio no quiso dar.
 *
 * Es un REEMPLAZO de la lista completa, mismo criterio que `guardarPromociones`
 * y que los items de una promoción: el panel edita el conjunto entero.
 *
 * ⚠️ Desasociar NO borra el producto: sigue en el catálogo con su stock, su
 * precio y sus fotos. Sólo deja de estar en esta vitrina.
 *
 * A diferencia de `guardarPromociones`, responde el DETALLE completo y no la
 * lista de ids: el editor pinta la vitrina con nombre, precio y portada, y
 * devolverle ids lo obligaría a un segundo GET para dibujar lo que acaba de
 * guardar. Mismo criterio que `PUT /promociones/:id/items`.
 */
export async function guardarProductos(req, res, next) {
  try {
    const id = idDeParams(req);
    await buscarOFallar(id);

    const productIds = req.body?.productIds;
    if (!Array.isArray(productIds)) {
      throw httpError(400, "Enviá la lista de productos en `productIds`.");
    }
    if (productIds.length > MAX_PRODUCTOS_CAMPANIA) {
      throw httpError(
        400,
        `Una campaña no puede mostrar más de ${MAX_PRODUCTOS_CAMPANIA} productos.`,
      );
    }
    if (!productIds.every((valor) => Number.isInteger(valor) && valor > 0)) {
      throw httpError(400, "Los ids de producto deben ser números enteros.");
    }
    // Un producto dos veces explota contra la PK compuesta como un P2002 que no
    // explica nada, y encima después de haber borrado la vitrina anterior.
    if (new Set(productIds).size !== productIds.length) {
      throw httpError(400, "Hay un producto repetido en la lista.");
    }

    await exigirIdsExistentes(prisma.product, productIds, { entidad: "Estos productos" });

    // En transacción: aplicada a medias dejaría la campaña con la mitad de la
    // vitrina vieja y la mitad de la nueva.
    await prisma.$transaction(async (tx) => {
      await tx.campaniaProducto.deleteMany({ where: { campaniaId: id } });
      if (productIds.length > 0) {
        await tx.campaniaProducto.createMany({
          data: productIds.map((productId) => ({ campaniaId: id, productId })),
        });
      }
    });

    logAudit(req, {
      accion: "ACTUALIZAR_PRODUCTOS",
      entidad: "Campania",
      entidadId: id,
      detalle: { productIds },
    });

    res.json(await mapDetalle(await leerDetalle(id), new Date()));
  } catch (err) {
    next(err);
  }
}
