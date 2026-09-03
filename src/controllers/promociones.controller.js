import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { LARGO_MAX_TEXTO } from "../lib/limitesTexto.js";
import { parsearPaginacion } from "../lib/paginacion.js";
import { subtotalDeItem } from "../lib/dinero.js";
import { claveDiaArgentino, inicioDelDiaArgentino } from "../lib/horarioArgentino.js";
import { detectarConflictos } from "../lib/conflictosPromociones.js";
import { ESTADOS_FACTURABLES } from "./admin.controller.js";
import { LIST_SELECT } from "./products.mapper.js";
import {
  PORCENTAJE_MAX,
  PORCENTAJE_MIN,
  esPorcentajeValido,
  precioConDescuento,
} from "../lib/precioEfectivo.js";

/**
 * ADMIN → Promociones: QUÉ productos tienen QUÉ descuento.
 *
 * **Acá NO hay fechas, y esa ausencia es el módulo entero.** La promoción
 * define el descuento; el calendario define cuándo se aplica. Una promoción sin
 * programación no le llega a nadie, y la misma se puede programar muchas veces
 * sin duplicarse.
 *
 * Por eso `crear` RECHAZA un body con fechas en vez de ignorarlas: aceptarlas
 * en silencio le enseñaría a un llamador que este endpoint programa.
 */

/** Espeja `@db.NVarChar(120)`, mismo criterio que el resto del proyecto. */
export const LARGO_MAX_NOMBRE_PROMOCION = 120;

/** Tope de productos por promoción. De producto, no técnico. */
export const MAX_ITEMS_PROMOCION = 200;

/** Claves que delatan a alguien intentando programar desde acá. */
const CLAVES_DE_FECHA = ["desde", "hasta", "fechaInicio", "fechaFin", "programacion"];

function idDeParams(req, campo = "id") {
  const id = Number(req.params[campo]);
  if (!Number.isInteger(id)) throw httpError(404, "Promoción no encontrada.");
  return id;
}

function parsearNombre(body) {
  const nombre = typeof body?.nombre === "string" ? body.nombre.trim() : "";
  if (!nombre) throw httpError(400, "El nombre de la promoción es obligatorio.");
  if (nombre.length > LARGO_MAX_NOMBRE_PROMOCION) {
    throw httpError(400, `El nombre no puede superar los ${LARGO_MAX_NOMBRE_PROMOCION} caracteres.`);
  }
  return nombre;
}

function parsearDescripcion(body) {
  if (body?.descripcion === undefined || body.descripcion === null) return null;
  if (typeof body.descripcion !== "string") throw httpError(400, "La descripción debe ser texto.");
  const descripcion = body.descripcion.trim();
  if (descripcion.length > LARGO_MAX_TEXTO) {
    throw httpError(400, `La descripción no puede superar los ${LARGO_MAX_TEXTO} caracteres.`);
  }
  return descripcion || null;
}

/**
 * Corta a quien intente programar desde este módulo.
 *
 * El mensaje nombra el calendario a propósito: un 400 genérico dejaría a quien
 * lo recibe buscando qué campo está mal, cuando el problema es que está en el
 * lugar equivocado.
 */
function rechazarFechas(body) {
  const encontrada = CLAVES_DE_FECHA.find((clave) => body?.[clave] !== undefined);
  if (encontrada) {
    throw httpError(
      400,
      "Una promoción no lleva fechas: se programa desde el calendario. Quitá `" + encontrada + "`.",
    );
  }
}

/** La forma del LISTADO: sin items, que crecen sin techo. */
function mapPromocionListado(promocion) {
  return {
    id: promocion.id,
    nombre: promocion.nombre,
    descripcion: promocion.descripcion,
    activa: promocion.activa,
    cantidadProductos: promocion.items?.length ?? 0,
    // Las dos preguntas que se hacen mirando la lista: a cuántos alcanza, y si
    // está haciendo algo. Sin ellas hay que abrir cada promoción.
    programada:
      (promocion.programaciones?.length ?? 0) > 0 || (promocion.campanias?.length ?? 0) > 0,
  };
}

/**
 * La forma del DETALLE. Cada producto trae su precio promocional YA CALCULADO,
 * para que el admin vea a cuánto queda antes de programar nada — y para que esa
 * cuenta la haga el mismo módulo que después la va a cobrar.
 */
function mapPromocionDetalle(promocion) {
  return {
    id: promocion.id,
    nombre: promocion.nombre,
    descripcion: promocion.descripcion,
    activa: promocion.activa,
    items: (promocion.items ?? []).map((item) => {
      const promocional = precioConDescuento(item.product.precio, item.porcentaje);
      return {
        productId: item.productId,
        sku: item.product.sku,
        nombre: item.product.nombre,
        porcentaje: item.porcentaje,
        habilitado: item.habilitado,
        precio: item.product.precio.toString(),
        precioPromocional: promocional === null ? null : promocional.toString(),
      };
    }),
  };
}

const DETALLE_INCLUDE = {
  items: {
    include: { product: { select: { id: true, sku: true, nombre: true, precio: true } } },
    orderBy: { id: "asc" },
  },
};

async function buscarOFallar(id, include = DETALLE_INCLUDE) {
  const promocion = await prisma.promocion.findUnique({ where: { id }, include });
  if (!promocion) throw httpError(404, "Promoción no encontrada.");
  return promocion;
}

export async function listar(_req, res, next) {
  try {
    const promociones = await prisma.promocion.findMany({
      include: {
        items: { select: { id: true } },
        programaciones: { select: { id: true } },
        campanias: { select: { campaniaId: true } },
      },
      orderBy: [{ nombre: "asc" }, { id: "asc" }],
    });
    res.json(promociones.map(mapPromocionListado));
  } catch (err) {
    next(err);
  }
}

export async function obtenerPorId(req, res, next) {
  try {
    res.json(mapPromocionDetalle(await buscarOFallar(idDeParams(req))));
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  try {
    rechazarFechas(req.body);
    const promocion = await prisma.promocion.create({
      data: { nombre: parsearNombre(req.body), descripcion: parsearDescripcion(req.body) },
      include: DETALLE_INCLUDE,
    });

    logAudit(req, {
      accion: "CREAR",
      entidad: "Promocion",
      entidadId: promocion.id,
      detalle: { nombre: promocion.nombre },
    });

    res.status(201).json(mapPromocionDetalle(promocion));
  } catch (err) {
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    rechazarFechas(req.body);
    const id = idDeParams(req);
    const actual = await buscarOFallar(id);

    const activa =
      req.body?.activa === undefined
        ? actual.activa
        : (() => {
            if (typeof req.body.activa !== "boolean") {
              throw httpError(400, "`activa` debe ser un booleano.");
            }
            return req.body.activa;
          })();

    const promocion = await prisma.promocion.update({
      where: { id },
      data: { nombre: parsearNombre(req.body), descripcion: parsearDescripcion(req.body), activa },
      include: DETALLE_INCLUDE,
    });

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Promocion",
      entidadId: id,
      detalle: {
        anterior: { nombre: actual.nombre, activa: actual.activa },
        nuevo: { nombre: promocion.nombre, activa: promocion.activa },
      },
    });

    res.json(mapPromocionDetalle(promocion));
  } catch (err) {
    next(err);
  }
}

/**
 * `PUT /promociones/:id/items` — reemplaza la lista COMPLETA de productos.
 *
 * Es un reemplazo y no un merge porque el panel edita la tabla entera: mandar
 * la lista vigente es la forma natural de expresar "quedó así", y evita tres
 * endpoints (agregar, quitar, cambiar el porcentaje) que después hay que
 * mantener coherentes entre sí.
 *
 * Va en TRANSACCIÓN: aplicado a medias dejaría la promoción con la mitad vieja
 * y la mitad nueva, que es un descuento que nadie pidió.
 *
 * ⚠️ El reemplazo PIERDE los `habilitado: false` de los conflictos resueltos.
 * Es correcto: cambiar la lista de productos es rearmar la promoción, y las
 * decisiones de conflicto se tomaron sobre la lista anterior.
 */
export async function guardarItems(req, res, next) {
  try {
    const id = idDeParams(req);
    await buscarOFallar(id);

    const items = req.body?.items;
    if (!Array.isArray(items)) throw httpError(400, "Enviá la lista de productos en `items`.");
    if (items.length > MAX_ITEMS_PROMOCION) {
      throw httpError(400, `Una promoción no puede tener más de ${MAX_ITEMS_PROMOCION} productos.`);
    }

    const normalizados = items.map((item) => {
      const productId = Number(item?.productId);
      if (!Number.isInteger(productId) || productId <= 0) {
        throw httpError(400, "Cada producto necesita un `productId` válido.");
      }
      if (!esPorcentajeValido(item?.porcentaje)) {
        throw httpError(
          400,
          `El descuento tiene que ser un número entero entre ${PORCENTAJE_MIN} y ${PORCENTAJE_MAX}.`,
        );
      }
      return { promocionId: id, productId, porcentaje: item.porcentaje };
    });

    // Un producto dos veces no tiene respuesta: cuál de los dos porcentajes
    // gana. La base también lo impide con su unique, pero un P2002 sale como
    // "ya existe un registro con ese valor" y no explica nada.
    const ids = normalizados.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) {
      throw httpError(400, "Hay un producto repetido en la lista.");
    }

    if (ids.length > 0) {
      const existentes = await prisma.product.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      });
      // Se nombra el que falta en vez de comparar largos: el mensaje sirve
      // para algo, y no depende de que la consulta devuelva exactamente el
      // conjunto pedido.
      const presentes = new Set(existentes.map((p) => p.id));
      const faltantes = ids.filter((id) => !presentes.has(id));
      if (faltantes.length > 0) {
        throw httpError(
          400,
          `Estos productos ya no existen: ${faltantes.join(", ")}. Recargá la pantalla.`,
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.promocionItem.deleteMany({ where: { promocionId: id } });
      if (normalizados.length > 0) {
        await tx.promocionItem.createMany({ data: normalizados });
      }
    });

    logAudit(req, {
      accion: "ACTUALIZAR_ITEMS",
      entidad: "Promocion",
      entidadId: id,
      detalle: { cantidad: normalizados.length },
    });

    res.json(mapPromocionDetalle(await buscarOFallar(id)));
  } catch (err) {
    next(err);
  }
}

/**
 * `PATCH /promociones/:id/items/:productId` — prende o apaga UN producto.
 *
 * Es la resolución de un conflicto, y por eso es por producto: cuando dos
 * promociones se pisan, la perdedora queda apagada SOLO para ese producto y
 * sigue funcionando para todos los demás.
 *
 * **No se reactiva sola** cuando la ganadora termina: volver a `true` pasa por
 * acá, con alguien decidiéndolo.
 */
export async function cambiarEstadoItem(req, res, next) {
  try {
    const id = idDeParams(req);
    const productId = idDeParams(req, "productId");
    await buscarOFallar(id);

    if (typeof req.body?.habilitado !== "boolean") {
      throw httpError(400, "`habilitado` debe ser un booleano.");
    }

    const [item] = await prisma.promocionItem.findMany({
      where: { promocionId: id, productId },
      select: { id: true },
      take: 1,
    });
    if (!item) throw httpError(404, "Ese producto no está en la promoción.");

    await prisma.promocionItem.update({
      where: { id: item.id },
      data: { habilitado: req.body.habilitado },
    });

    logAudit(req, {
      accion: req.body.habilitado ? "REACTIVAR_ITEM" : "DESACTIVAR_ITEM",
      entidad: "Promocion",
      entidadId: id,
      detalle: { productId },
    });

    res.json(mapPromocionDetalle(await buscarOFallar(id)));
  } catch (err) {
    next(err);
  }
}

export async function eliminar(req, res, next) {
  try {
    const id = idDeParams(req);
    const promocion = await buscarOFallar(id, undefined);

    await prisma.promocion.delete({ where: { id } });

    logAudit(req, {
      accion: "ELIMINAR",
      entidad: "Promocion",
      entidadId: id,
      detalle: { nombre: promocion.nombre },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * `GET /promociones/productos` — el listado comercial.
 *
 * Cruza TRES fuentes que hoy ningún otro endpoint junta:
 *
 * - lo que trae `LIST_SELECT` (precio, costo, coeficiente, vistas, foto);
 * - las **ventas**, que se agregan en memoria sobre `Orden.items` porque Prisma
 *   no sabe sumar la expresión `precioUnitario × cantidad`;
 * - en qué **promociones** participa cada producto.
 *
 * ⚠️ **Las ventas se agregan SOLO sobre los productos de la página.** Recorrer
 * el histórico entero para pintar veinte filas se traería 20.000 órdenes en
 * cada carga de la pantalla.
 */
export async function listadoComercial(req, res, next) {
  try {
    const { page, pageSize } = parsearPaginacion(req.query);

    const where = {};
    if (req.query.categoria !== undefined) {
      const categoriaId = Number(req.query.categoria);
      if (Number.isInteger(categoriaId)) where.categoriaId = categoriaId;
    }

    const [total, productos] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        select: LIST_SELECT,
        orderBy: [{ vistas: "desc" }, { id: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const ids = productos.map((p) => p.id);
    const [ordenes, itemsPromo] = await Promise.all([
      ids.length === 0
        ? []
        : prisma.orden.findMany({
            // Una CANCELADA no es una venta, mismo criterio que el resto de la
            // analítica del proyecto (`ESTADOS_FACTURABLES`).
            where: { estado: { in: ESTADOS_FACTURABLES }, items: { some: { productId: { in: ids } } } },
            select: { items: { select: { productId: true, cantidad: true, precioUnitario: true } } },
          }),
      ids.length === 0
        ? []
        : prisma.promocionItem.findMany({
            where: { productId: { in: ids } },
            select: {
              productId: true,
              porcentaje: true,
              promocion: { select: { id: true, nombre: true } },
            },
          }),
    ]);

    const ventas = new Map();
    for (const orden of ordenes) {
      for (const item of orden.items) {
        if (item.productId === null || !ids.includes(item.productId)) continue;
        const acumulado = ventas.get(item.productId) ?? { unidades: 0, facturacion: null };
        acumulado.unidades += item.cantidad;
        acumulado.facturacion =
          acumulado.facturacion === null
            ? subtotalDeItem(item)
            : acumulado.facturacion.plus(subtotalDeItem(item));
        ventas.set(item.productId, acumulado);
      }
    }

    const promosPorProducto = new Map();
    for (const item of itemsPromo) {
      const lista = promosPorProducto.get(item.productId) ?? [];
      lista.push({ id: item.promocion.id, nombre: item.promocion.nombre, porcentaje: item.porcentaje });
      promosPorProducto.set(item.productId, lista);
    }

    const data = productos.map((producto) => {
      const venta = ventas.get(producto.id) ?? { unidades: 0, facturacion: null };
      return {
        id: producto.id,
        sku: producto.sku,
        nombre: producto.nombre,
        categoria: producto.categoria ? { id: producto.categoria.id, nombre: producto.categoria.nombre } : null,
        fotoPortada: producto.fotos[0]?.url ?? null,
        visibleEnCatalogo: producto.visibleEnCatalogo,
        stock: producto.stock,
        vistas: producto.vistas,
        unidadesVendidas: venta.unidades,
        facturacion: venta.facturacion === null ? null : venta.facturacion.toFixed(0),
        // El §18 del pedido —"muchas visualizaciones y pocas ventas"— resuelto
        // con un número derivado, sin nada raro. `null` SIN VISTAS, nunca cero:
        // cero diría "nadie de los que lo vieron compró", y nadie lo vio. Es la
        // misma distinción que `costoUnitario: null` vs. margen 0.
        conversion: producto.vistas > 0 ? (venta.unidades / producto.vistas) * 100 : null,
        costo: producto.costo?.toString() ?? null,
        coeficiente: producto.coeficiente?.toString() ?? null,
        precio: producto.precio.toString(),
        promociones: promosPorProducto.get(producto.id) ?? [],
      };
    });

    res.json({ data, page, pageSize, total });
  } catch (err) {
    next(err);
  }
}

/* ── Programaciones ───────────────────────────────────────────────────────────
 *
 * Es lo que hace que una promoción le llegue a alguien. Sin programar, el
 * módulo entero es una lista de intenciones.
 *
 * Los endpoints viven bajo `/promociones` porque una programación no existe sin
 * su promoción, pero **la acción de programar es del CALENDARIO**: la pantalla
 * de Promociones no los llama, los llama `AdminCampanias`.
 */

/** `"YYYY-MM-DD"` → la medianoche ARGENTINA de ese día. */
function parsearDia(valor, campo) {
  if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    throw httpError(400, `La fecha de ${campo} debe tener el formato AAAA-MM-DD.`);
  }
  const fecha = inicioDelDiaArgentino(valor);
  if (fecha === null) throw httpError(400, `La fecha de ${campo} no es válida.`);
  return fecha;
}

function mapProgramacion(programacion) {
  return {
    id: programacion.id,
    promocionId: programacion.promocion?.id ?? programacion.promocionId,
    nombre: programacion.promocion?.nombre ?? null,
    // Como en las campañas: `"YYYY-MM-DD"`, no ISO con hora. `formatFecha`
    // detecta ese formato y lo descompone a mano para no correrlo un día.
    desde: claveDiaArgentino(programacion.desde),
    hasta: claveDiaArgentino(programacion.hasta),
    habilitada: programacion.habilitada,
  };
}

/**
 * `GET /promociones/programaciones?desde&hasta` — las del mes visible.
 *
 * Filtro de SOLAPAMIENTO, igual que el de campañas: una programación de agosto
 * a octubre ocupa septiembre y tiene que aparecer al mirar ese mes.
 */
export async function listarProgramaciones(req, res, next) {
  try {
    const where = {};
    if (req.query.desde !== undefined || req.query.hasta !== undefined) {
      const desde = parsearDia(req.query.desde, "inicio");
      const hasta = parsearDia(req.query.hasta, "fin");
      where.desde = { lte: hasta };
      where.hasta = { gte: desde };
    }

    const programaciones = await prisma.programacionPromocion.findMany({
      where,
      include: { promocion: { select: { id: true, nombre: true, activa: true } } },
      orderBy: [{ desde: "desc" }, { id: "desc" }],
    });

    res.json(programaciones.map(mapProgramacion));
  } catch (err) {
    next(err);
  }
}

/** `POST /promociones/:id/programaciones` — programa una promoción suelta. */
export async function crearProgramacion(req, res, next) {
  try {
    const promocionId = idDeParams(req);
    await buscarOFallar(promocionId, undefined);

    const desde = parsearDia(req.body?.desde, "inicio");
    const hasta = parsearDia(req.body?.hasta, "fin");
    if (desde.getTime() > hasta.getTime()) {
      throw httpError(400, "La fecha de inicio no puede ser posterior a la de fin.");
    }

    const programacion = await prisma.programacionPromocion.create({
      // Nace HABILITADA: programar algo ES querer que se aplique. Que naciera
      // apagada obligaría a un segundo paso que nadie va a recordar.
      data: { promocionId, desde, hasta, habilitada: true },
      include: { promocion: { select: { id: true, nombre: true, activa: true } } },
    });

    logAudit(req, {
      accion: "PROGRAMAR",
      entidad: "Promocion",
      entidadId: promocionId,
      detalle: { desde: req.body.desde, hasta: req.body.hasta },
    });

    res.status(201).json(mapProgramacion(programacion));
  } catch (err) {
    next(err);
  }
}

async function buscarProgramacionOFallar(req) {
  const id = Number(req.params.programacionId);
  if (!Number.isInteger(id)) throw httpError(404, "Programación no encontrada.");
  const programacion = await prisma.programacionPromocion.findUnique({ where: { id } });
  if (!programacion) throw httpError(404, "Programación no encontrada.");
  return programacion;
}

/**
 * `PATCH /promociones/programaciones/:programacionId` — el OFF manual del §24.
 *
 * Apaga la programación **sin borrarla ni tocar sus fechas**: la promoción deja
 * de aplicarse en el acto y el período queda ahí para volver a prenderla. Es lo
 * mismo que el ON/OFF de una campaña, un nivel más abajo.
 */
export async function cambiarEstadoProgramacion(req, res, next) {
  try {
    const programacion = await buscarProgramacionOFallar(req);
    if (typeof req.body?.habilitada !== "boolean") {
      throw httpError(400, "`habilitada` debe ser un booleano.");
    }

    const actualizada = await prisma.programacionPromocion.update({
      where: { id: programacion.id },
      data: { habilitada: req.body.habilitada },
      include: { promocion: { select: { id: true, nombre: true, activa: true } } },
    });

    logAudit(req, {
      accion: req.body.habilitada ? "PROGRAMACION_ON" : "PROGRAMACION_OFF",
      entidad: "Promocion",
      entidadId: programacion.promocionId,
      detalle: { programacionId: programacion.id },
    });

    res.json(mapProgramacion(actualizada));
  } catch (err) {
    next(err);
  }
}

/** `DELETE /promociones/programaciones/:programacionId` — borra el período. */
export async function eliminarProgramacion(req, res, next) {
  try {
    const programacion = await buscarProgramacionOFallar(req);

    await prisma.programacionPromocion.delete({ where: { id: programacion.id } });

    logAudit(req, {
      accion: "DESPROGRAMAR",
      entidad: "Promocion",
      entidadId: programacion.promocionId,
      detalle: { programacionId: programacion.id },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * `GET /promociones/conflictos` — dónde dos promociones se pisan el precio.
 *
 * SOLO LECTURA y sin estado: los conflictos se calculan cada vez, no se
 * guardan. Guardarlos obligaría a recalcularlos ante cualquier cambio de
 * programación, de items o de estado de campaña — y el §41 pide justamente que
 * agregar un producto a una promoción ya programada haga aparecer el conflicto
 * nuevo. Una consulta lo resuelve; un snapshot habría que invalidarlo.
 *
 * Los PERÍODOS de una promoción salen de sus dos caminos: las programaciones
 * habilitadas, y las campañas asociadas que estén HABILITADAS. Una campaña
 * apagada o una programación en OFF **no aportan período**, así que sus
 * promociones dejan de competir — que es lo correcto: apagarlas ya resolvió el
 * conflicto de hecho.
 */
export async function listarConflictos(_req, res, next) {
  try {
    const promociones = await prisma.promocion.findMany({
      where: { activa: true },
      include: {
        items: {
          where: { habilitado: true },
          select: {
            productId: true,
            porcentaje: true,
            habilitado: true,
            product: { select: { nombre: true } },
          },
        },
        programaciones: { select: { desde: true, hasta: true, habilitada: true } },
        campanias: {
          select: { campania: { select: { estado: true, desde: true, hasta: true } } },
        },
      },
    });

    const paraDetectar = promociones.map((promocion) => ({
      id: promocion.id,
      nombre: promocion.nombre,
      items: promocion.items.map((item) => ({
        productId: item.productId,
        porcentaje: item.porcentaje,
        habilitado: item.habilitado,
        nombreProducto: item.product.nombre,
      })),
      periodos: [
        ...promocion.programaciones
          .filter((p) => p.habilitada)
          .map((p) => ({ desde: claveDiaArgentino(p.desde), hasta: claveDiaArgentino(p.hasta) })),
        ...promocion.campanias
          .filter((a) => a.campania.estado === "HABILITADA")
          .map((a) => ({
            desde: claveDiaArgentino(a.campania.desde),
            hasta: claveDiaArgentino(a.campania.hasta),
          })),
      ],
    }));

    res.json(detectarConflictos(paraDetectar));
  } catch (err) {
    next(err);
  }
}
