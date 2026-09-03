import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { esRequestDeAdmin } from "../middlewares/auth.middleware.js";
import { LARGO_MAX_TEXTO } from "../lib/limitesTexto.js";
import { ALLOWED_PHOTO_MIMES } from "../lib/limitesMedios.js";
import { contenidoCoincideConMime } from "../lib/magicBytes.js";
import { subirArchivo, eliminarArchivo } from "../services/cloudinary.service.js";
import { claveDiaArgentino, inicioDelDiaArgentino } from "../lib/horarioArgentino.js";
import {
  ESTADOS_CAMPANIA,
  TIPOS_CAMPANIA,
  elegirPorPrioridad,
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
  res.json({ tipos: listaDeTipos(), estados: listaDeEstadosCampania() });
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

    const cuerpo = {
      claveDia: claveDiaArgentino(ahora),
      doodle: aDoodlePublico(elegirPorPrioridad(conDoodle.filter((c) => c.doodleEnCatalogo))),
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

    const campanias = await prisma.campania.findMany({ where, orderBy: ORDEN_LISTADO });

    res.json(campanias.map((campania) => mapCampania(campania, ahora)));
  } catch (err) {
    next(err);
  }
}

export async function obtenerPorId(req, res, next) {
  try {
    const campania = await buscarOFallar(idDeParams(req));
    res.json(mapCampania(campania, new Date()));
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  try {
    const datos = {
      nombre: parsearNombre(req.body),
      descripcion: parsearDescripcion(req.body),
      tipo: parsearTipo(req.body),
      estado: parsearEstado(req.body?.estado ?? "BORRADOR"),
      prioridad: parsearPrioridad(req.body),
      doodleEnCatalogo: parsearFlagDoodle(req.body, "doodleEnCatalogo", true),
      doodleEnAdmin: parsearFlagDoodle(req.body, "doodleEnAdmin", false),
      ...parsearRango(req.body),
    };

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

    const datos = {
      nombre: parsearNombre(req.body),
      descripcion: parsearDescripcion(req.body),
      tipo: parsearTipo(req.body),
      estado: parsearEstado(req.body?.estado ?? actual.estado),
      prioridad: parsearPrioridad(req.body),
      // Ausente = "no lo toques": cae al valor ACTUAL, no al default del alta.
      doodleEnCatalogo: parsearFlagDoodle(req.body, "doodleEnCatalogo", actual.doodleEnCatalogo),
      doodleEnAdmin: parsearFlagDoodle(req.body, "doodleEnAdmin", actual.doodleEnAdmin),
      ...parsearRango(req.body),
    };

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
 */
export async function duplicar(req, res, next) {
  try {
    const id = idDeParams(req);
    const original = await buscarOFallar(id);

    // Se enumeran los campos a copiar en vez de hacer spread con delete: así,
    // una columna nueva en el modelo NO se cuela en el duplicado sin que
    // alguien lo haya decidido acá.
    const campania = await prisma.campania.create({
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
      },
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
