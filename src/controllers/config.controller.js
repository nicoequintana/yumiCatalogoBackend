import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { esRequestDeAdmin } from "../middlewares/auth.middleware.js";
import { estaDentroDeHorario } from "../lib/horarioAtencion.js";
import { esEmailValido } from "../lib/emailValido.js";
import { esUrlHttpsValida } from "../lib/urlHttpsValida.js";
import { PRODUCT_INCLUDE, mapProducto } from "./products.mapper.js";
import { resolverDescuentos } from "../lib/precioEfectivo.js";
import { esEnteroSeguro } from "../lib/enteroSeguro.js";

const TEXTO_EN_HORARIO = "Te respondemos ahora";
const TEXTO_FUERA_DE_HORARIO = "Fuera de horario de atención — te respondemos apenas podamos";

/** Fila única de `ConfiguracionContacto` (ver schema.prisma). */
const ID_CONFIGURACION = 1;

/** Fila única de `ConfiguracionHome` (ver schema.prisma) — mismo patrón. */
const ID_CONFIGURACION_HOME = 1;

// Espejan las columnas de `ConfiguracionContacto` en schema.prisma — un valor
// más largo produciría un P2000 que el error handler traduce a un 400
// genérico sin decir qué campo ni cuál es el límite. Mismo criterio que
// `LARGO_MAX_ANUNCIO` en anuncios.controller.js.
const LARGO_MAX_EMAIL = 255;
const LARGO_MAX_URL_SOCIAL = 300;
const LARGO_MAX_DIRECCION = 300;

const REGEX_WHATSAPP_NUMERO = /^\d{10,15}$/;
const DIAS_VALIDOS = new Set([0, 1, 2, 3, 4, 5, 6]);

function diasDesdeString(valor) {
  if (typeof valor !== "string" || valor.trim() === "") return [];
  return valor
    .split(",")
    .map((d) => Number(d.trim()))
    .filter((d) => !Number.isNaN(d));
}

function diasDesdeEnv() {
  return diasDesdeString(process.env.WHATSAPP_DIAS ?? "");
}

/**
 * Arma el bloque `{numero, dentroDeHorario, textoHorario}` a partir de la fila
 * de la base (o `null` si no existe todavía), con FALLBACK POR CAMPO a las env
 * vars `WHATSAPP_*` — cada columna NULL cae a su variable homónima, así que
 * una base con solo el número cargado sigue usando el horario del `.env` hasta
 * que alguien también lo guarde desde el panel.
 */
function construirWhatsapp(fila) {
  const numero = fila?.whatsappNumero ?? process.env.WHATSAPP_NUMERO;
  const horaDesde = fila?.whatsappHoraDesde ?? Number(process.env.WHATSAPP_HORA_DESDE);
  const horaHasta = fila?.whatsappHoraHasta ?? Number(process.env.WHATSAPP_HORA_HASTA);
  const dias = fila?.whatsappDias != null ? diasDesdeString(fila.whatsappDias) : diasDesdeEnv();

  const dentroDeHorario = estaDentroDeHorario({ horaDesde, horaHasta, dias });

  return {
    numero,
    dentroDeHorario,
    textoHorario: dentroDeHorario ? TEXTO_EN_HORARIO : TEXTO_FUERA_DE_HORARIO,
  };
}

/** Forma pública de `GET /config/contacto`: nulls cuando no hay dato guardado. */
function construirVistaPublica(fila) {
  return {
    whatsapp: construirWhatsapp(fila),
    email: fila?.email ?? null,
    instagram: fila?.instagramUrl ?? null,
    facebook: fila?.facebookUrl ?? null,
    tiktok: fila?.tiktokUrl ?? null,
    direccion: fila?.direccion ?? null,
  };
}

/**
 * Valores CRUDOS de la fila (sin fallback a entorno), para que el formulario
 * del panel edite lo que REALMENTE hay guardado — no el valor resuelto que ve
 * el catálogo público, que puede venir del `.env` y no de la base.
 */
function construirCrudo(fila) {
  return {
    whatsappNumero: fila?.whatsappNumero ?? null,
    whatsappHoraDesde: fila?.whatsappHoraDesde ?? null,
    whatsappHoraHasta: fila?.whatsappHoraHasta ?? null,
    whatsappDias: fila?.whatsappDias ?? null,
    email: fila?.email ?? null,
    instagramUrl: fila?.instagramUrl ?? null,
    facebookUrl: fila?.facebookUrl ?? null,
    tiktokUrl: fila?.tiktokUrl ?? null,
    direccion: fila?.direccion ?? null,
  };
}

/**
 * `crudo` es una clave ADITIVA: sale SOLO con `esRequestDeAdmin(req)`, mismo
 * criterio que `campania` en `GET /products` o `doodleAdmin` en
 * `GET /campanias/activas`. El modo admin sale del TOKEN, nunca de la
 * querystring — no hay forma de pedir `crudo` con un `?admin=1` como antes
 * podía pedirse ver productos ocultos.
 */
function construirVista(fila, { admin }) {
  const vista = construirVistaPublica(fila);
  if (admin) vista.crudo = construirCrudo(fila);
  return vista;
}

/**
 * `GET /config/whatsapp`.
 *
 * DECISIÓN: un error de la consulta a la base NO cae a un fallback silencioso
 * de entorno — se propaga a `next(err)` y responde 500, exactamente igual que
 * cualquier otro GET público de este backend (`GET /products`, `GET
 * /categorias`, etc.) ninguno de los cuales atrapa un error de Prisma para
 * degradar la respuesta. Tragar el error acá sería la única lectura pública
 * del sistema que lo hace, y dejaría un supuesto "sin horario configurado"
 * indistinguible de una base caída.
 */
export async function whatsapp(_req, res, next) {
  try {
    const fila = await prisma.configuracionContacto.findUnique({ where: { id: ID_CONFIGURACION } });
    res.json(construirWhatsapp(fila));
  } catch (err) {
    next(err);
  }
}

/**
 * `GET /config/contacto` — `authOpcional`: la forma pública alimenta el
 * catálogo (WhatsApp, mail, redes, dirección) y la vista admin suma `crudo`
 * para que Configuración › Contacto edite el dato real, no el resuelto.
 */
export async function contacto(req, res, next) {
  try {
    const fila = await prisma.configuracionContacto.findUnique({ where: { id: ID_CONFIGURACION } });
    res.json(construirVista(fila, { admin: esRequestDeAdmin(req) }));
  } catch (err) {
    next(err);
  }
}

/**
 * Normaliza un campo de texto libre: recorta espacios y un string vacío pasa
 * a `null` ("bórralo"), nunca a un 400 — mismo criterio que `parseActivo` de
 * `anuncios.controller.js` para lo opcional, pero acá aplicado a texto.
 * `undefined` se preserva tal cual ("no lo toques").
 */
function normalizarTexto(valor) {
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  if (typeof valor !== "string") throw httpError(400, "El valor enviado no es un texto válido.");
  const recortado = valor.trim();
  return recortado === "" ? null : recortado;
}

function parsearWhatsappNumero(body) {
  const valor = normalizarTexto(body?.whatsappNumero);
  if (valor === undefined || valor === null) return valor;
  if (!REGEX_WHATSAPP_NUMERO.test(valor)) {
    throw httpError(
      400,
      "El número de WhatsApp debe tener solo dígitos, entre 10 y 15 (formato internacional sin \"+\").",
    );
  }
  return valor;
}

function parsearHora(valor, nombreCampo) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === "") return null;
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < 0 || numero > 23) {
    throw httpError(400, `${nombreCampo} debe ser un número entero entre 0 y 23.`);
  }
  return numero;
}

function parsearDias(body) {
  const valor = normalizarTexto(body?.whatsappDias);
  if (valor === undefined || valor === null) return valor;

  const numeros = valor.split(",").map((parte) => Number(parte.trim()));
  const esValido = numeros.length > 0 && numeros.every((n) => Number.isInteger(n) && DIAS_VALIDOS.has(n));
  if (!esValido) {
    throw httpError(
      400,
      "whatsappDias debe ser una lista de números entre 0 (domingo) y 6 (sábado), separados por coma.",
    );
  }
  return valor;
}

function parsearEmail(body) {
  const valor = normalizarTexto(body?.email);
  if (valor === undefined || valor === null) return valor;
  if (!esEmailValido(valor)) throw httpError(400, "El email no tiene un formato válido.");
  if (valor.length > LARGO_MAX_EMAIL) {
    throw httpError(400, `El email no puede superar los ${LARGO_MAX_EMAIL} caracteres.`);
  }
  return valor;
}

function parsearUrlSocial(body, campo, etiqueta) {
  const valor = normalizarTexto(body?.[campo]);
  if (valor === undefined || valor === null) return valor;
  if (!esUrlHttpsValida(valor)) {
    throw httpError(400, `${etiqueta} debe ser una URL https:// válida.`);
  }
  if (valor.length > LARGO_MAX_URL_SOCIAL) {
    throw httpError(400, `${etiqueta} no puede superar los ${LARGO_MAX_URL_SOCIAL} caracteres.`);
  }
  return valor;
}

function parsearDireccion(body) {
  const valor = normalizarTexto(body?.direccion);
  if (valor === undefined || valor === null) return valor;
  if (valor.length > LARGO_MAX_DIRECCION) {
    throw httpError(400, `La dirección no puede superar los ${LARGO_MAX_DIRECCION} caracteres.`);
  }
  return valor;
}

/**
 * `PUT /config/contacto` — `requireAuth`. Todos los campos son opcionales y
 * `undefined` significa "no lo toques" (mismo criterio que `PUT /anuncios/:id`
 * con `activo`): el body puede mandar un único campo suelto sin reenviar el
 * resto del formulario.
 */
export async function actualizarContacto(req, res, next) {
  try {
    const datos = {
      whatsappNumero: parsearWhatsappNumero(req.body),
      whatsappHoraDesde: parsearHora(req.body?.whatsappHoraDesde, "whatsappHoraDesde"),
      whatsappHoraHasta: parsearHora(req.body?.whatsappHoraHasta, "whatsappHoraHasta"),
      whatsappDias: parsearDias(req.body),
      email: parsearEmail(req.body),
      instagramUrl: parsearUrlSocial(req.body, "instagramUrl", "Instagram"),
      facebookUrl: parsearUrlSocial(req.body, "facebookUrl", "Facebook"),
      tiktokUrl: parsearUrlSocial(req.body, "tiktokUrl", "TikTok"),
      direccion: parsearDireccion(req.body),
    };

    const { whatsappHoraDesde, whatsappHoraHasta } = datos;
    if (
      whatsappHoraDesde !== undefined &&
      whatsappHoraDesde !== null &&
      whatsappHoraHasta !== undefined &&
      whatsappHoraHasta !== null &&
      whatsappHoraDesde >= whatsappHoraHasta
    ) {
      throw httpError(400, "whatsappHoraDesde debe ser menor que whatsappHoraHasta.");
    }

    const actual = await prisma.configuracionContacto.findUnique({ where: { id: ID_CONFIGURACION } });

    const datosLimpios = Object.fromEntries(Object.entries(datos).filter(([, v]) => v !== undefined));

    const fila = await prisma.configuracionContacto.upsert({
      where: { id: ID_CONFIGURACION },
      update: datosLimpios,
      create: { id: ID_CONFIGURACION, ...datosLimpios },
    });

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "ConfiguracionContacto",
      entidadId: fila.id,
      detalle: { anterior: construirCrudo(actual), nuevo: construirCrudo(fila) },
    });

    res.json(construirVista(fila, { admin: true }));
  } catch (err) {
    next(err);
  }
}

/**
 * Arma `{productoIcono}` a partir de una fila de `Product` (o `null`).
 *
 * SIEMPRE forma pública (`mapProducto(producto, { descuento })` sin
 * `esAdmin`): este endpoint no es una pantalla de costeo, es el mismo bloque
 * que va a ver el visitante en la home — filtrar `costo`/`coeficiente` acá
 * sería la única lectura de producto del panel que además expone el dato al
 * anónimo, si algún día este mapeo se reusara sin pasar por la guarda.
 *
 * El descuento se resuelve con `resolverDescuentos`, la MISMA función que usa
 * cualquier otra vidriera pública (`GET /products`, `GET /products/:id`,
 * `GET /promociones/destacada`): sin esto, el producto ícono sería la única
 * superficie del catálogo que muestra un producto en oferta a precio de
 * lista mientras dura la promoción.
 */
async function mapearProductoIcono(producto) {
  if (!producto) return null;
  const descuentos = await resolverDescuentos(prisma, [producto.id]);
  return mapProducto(producto, { descuento: descuentos.get(producto.id) ?? null });
}

/**
 * `GET /config/home` — PÚBLICO. El producto ícono que la home muestra en su
 * sección homónima, con el detalle YA RESUELTO (mismo criterio que
 * `GET /products/:id`).
 *
 * Degrada a `productoIcono: null` en los tres casos en los que afirmar algo
 * sería mentir: nadie eligió un producto todavía, el producto elegido se
 * borró, o dejó de estar `visibleEnCatalogo`/con stock — mismo criterio "no
 * se afirma nada falso" del resto del catálogo público (`docs/reglas` §
 * Presencia pública).
 */
export async function obtenerConfiguracionHome(_req, res, next) {
  try {
    const config = await prisma.configuracionHome.findUnique({ where: { id: ID_CONFIGURACION_HOME } });

    const producto = config?.productoIconoId
      ? await prisma.product.findUnique({ where: { id: config.productoIconoId }, include: PRODUCT_INCLUDE })
      : null;

    const publicado = Boolean(producto) && producto.visibleEnCatalogo && producto.stock > 0;
    res.json({ productoIcono: publicado ? await mapearProductoIcono(producto) : null });
  } catch (err) {
    next(err);
  }
}

/**
 * `PUT /config/home` — `requireAuth`. Elige (o borra, con `null`) el producto
 * ícono de la home.
 *
 * La escritura EXIGE que el producto exista — `productoIconoId` no lleva FK a
 * `Product` (mismo motivo que `modalCtaReferenciaId` de `Campania`: sumarle
 * una FK a las que ya cuelgan de `Product` abre un segundo camino de cascada
 * y SQL Server la rechaza con el error 1785). La integridad va en las dos
 * puntas: acá se valida antes de guardar, `GET /config/home` degrada si la
 * referencia quedó colgada o dejó de estar publicada.
 *
 * A diferencia de la lectura pública, esta respuesta NO vuelve a exigir
 * `visibleEnCatalogo`/stock: el admin tiene que ver la verdad de lo que
 * acaba de guardar (por ejemplo, para elegir un producto y recién después
 * publicarlo), la guarda de "no afirmar nada falso" es del catálogo público,
 * no de esta pantalla.
 *
 * Responde el detalle actualizado directamente (mismo criterio que
 * `PATCH /categorias/:id/home`): un solo `findUnique` con `PRODUCT_INCLUDE`
 * sirve tanto para validar que el producto existe como para armar la
 * respuesta, sin una segunda consulta ni un segundo `GET` desde el cliente.
 */
export async function actualizarConfiguracionHome(req, res, next) {
  try {
    const { productoIconoId } = req.body ?? {};
    // `esEnteroSeguro` (`Number.isSafeInteger`), no `Number.isInteger`: es la
    // MISMA frontera que `lib/enteroSeguro.js` mide contra el SQL Server real
    // para cualquier entero que viaje a Prisma — un valor no representable
    // exacto (`> Number.MAX_SAFE_INTEGER`) revienta el query engine con un
    // error sin `status`, que el handler global vuelve 500. Acá, a diferencia
    // de un filtro de listado, el valor fuera de rango no se descarta en
    // silencio: es una escritura explícita, así que es 400.
    if (productoIconoId !== null && !esEnteroSeguro(productoIconoId)) {
      throw httpError(400, "productoIconoId debe ser un entero o null.");
    }

    let producto = null;
    if (productoIconoId !== null) {
      producto = await prisma.product.findUnique({ where: { id: productoIconoId }, include: PRODUCT_INCLUDE });
      if (!producto) throw httpError(400, "El producto elegido no existe.");
    }

    // `anterior`/`nuevo`, mismo criterio que `actualizarContacto`: sin esto la
    // auditoría dice QUE se tocó `ConfiguracionHome` pero no cuál era el
    // producto ícono antes del cambio.
    const actual = await prisma.configuracionHome.findUnique({ where: { id: ID_CONFIGURACION_HOME } });

    const config = await prisma.configuracionHome.upsert({
      where: { id: ID_CONFIGURACION_HOME },
      create: { id: ID_CONFIGURACION_HOME, productoIconoId },
      update: { productoIconoId },
    });

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "ConfiguracionHome",
      entidadId: ID_CONFIGURACION_HOME,
      detalle: { anterior: actual?.productoIconoId ?? null, nuevo: config.productoIconoId },
    });

    res.json({ productoIcono: await mapearProductoIcono(producto) });
  } catch (err) {
    next(err);
  }
}
