import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { parsearPaginacion } from "../lib/paginacion.js";
import { parsearIdEntero } from "../lib/enteroSeguro.js";
import {
  DETALLE_ORDEN_CUENTA_INCLUDE,
  LISTADO_ORDEN_CUENTA_INCLUDE,
  mapOrdenCuenta,
  mapOrdenCuentaListado,
} from "./ordenes.mapper.js";

/**
 * "Mis pedidos": las órdenes del comprador logueado.
 *
 * Vive en su propio controller y no en `cuenta.routes.js` porque acá el router
 * es cableado puro —cada ruta delega en un controller— y porque esto lee
 * `Orden`, no `CuentaCliente`: no pertenece a `cuentaPerfil` ni a
 * `cuentaLogin`. Del lado de órdenes tampoco: `ordenes.controller.js` es la
 * superficie ADMIN (`requireAuth`, `mapOrden`, `costoUnitario`), y mezclar las
 * dos superficies en un archivo es exactamente cómo se cuela un `include` de
 * admin en una respuesta del comprador.
 *
 * Las dos rutas comparten la misma regla de acceso: **la identidad sale
 * SIEMPRE de la sesión** (`req.cuentaCliente.id`), nunca de la URL, la query
 * ni el body. Amenazas 6 y 7 de la spec.
 */

/**
 * El id de la cuenta de la sesión, afirmado como entero ANTES de construir
 * ningún `where`.
 *
 * No es paranoia: `cuentaClienteId: { equals: undefined }` es un NO-OP para
 * Prisma —descarta la clave entera y devuelve las órdenes de TODAS las
 * cuentas—, así que un `id` corrupto no daría un error, daría el historial de
 * compras de todo el mundo con un 200. Si esto salta, es un bug de
 * `requireCliente`, y un 500 explícito es infinitamente preferible.
 *
 * @param {import("express").Request} req
 * @returns {number}
 */
function idDeSesion(req) {
  const id = req.cuentaCliente?.id;
  if (!Number.isInteger(id)) throw httpError(500, "No se pudo resolver la sesión.");
  return id;
}

/**
 * GET /api/cuenta/ordenes — el listado de "Mis pedidos".
 *
 * Filtra por `cuentaClienteId`, **NUNCA por DNI** (decisión 3 de la spec): la
 * cuenta arranca sin historial aunque su DNI coincida con compras de invitado
 * previas. Vincular por DNI dejaría ver compras hechas sin login, que pudo
 * haber hecho otra persona que tipeó mal su documento.
 *
 * Sobre estándar de los listados paginados (`{data, page, pageSize, total}`) y
 * `orderBy` FIJO `createdAt desc`, igual que `GET /ordenes`: el más reciente
 * primero es lo único que esta pantalla necesita ordenar.
 */
export async function listar(req, res, next) {
  try {
    const id = idDeSesion(req);
    const { page, pageSize } = parsearPaginacion(req.query);
    const where = { cuentaClienteId: { equals: id } };

    const [total, ordenes] = await Promise.all([
      prisma.orden.count({ where }),
      prisma.orden.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: LISTADO_ORDEN_CUENTA_INCLUDE,
      }),
    ]);

    res.json({ data: ordenes.map(mapOrdenCuentaListado), page, pageSize, total });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/cuenta/ordenes/:id — el detalle de un pedido propio.
 *
 * Dos decisiones que no se negocian:
 *
 * 1. **`findFirst` con el dueño EN EL MISMO `where`**, no `findUnique` por id
 *    y después un `if` comparando `orden.cuentaClienteId`. La orden ajena
 *    nunca se trae a memoria, así que no hay ninguna rama que se pueda olvidar
 *    de compararla ni ningún objeto ajeno rondando para que un `res.json`
 *    futuro lo devuelva. Es la misma regla que el resto del repo aplica a las
 *    condiciones que deciden un acceso: van en el WHERE.
 * 2. **404 y no 403** para una orden ajena, con el MISMO cuerpo que una
 *    inexistente. Un 403 confirmaría "este id existe, pero no es tuyo", y eso
 *    le regala a cualquier cuenta logueada un oráculo para contar las órdenes
 *    del sistema probando ids consecutivos.
 *
 * El id de la URL pasa por `parsearIdEntero`: fraccionario, negativo, no
 * numérico o fuera del rango seguro son 404 sin tocar la base — un `1e21`
 * llega al query engine y lo hace cortar con un 500 (ver `lib/enteroSeguro.js`).
 */
export async function obtenerPorId(req, res, next) {
  try {
    const id = idDeSesion(req);

    const ordenId = parsearIdEntero(req.params.id);
    if (ordenId === null) throw httpError(404, "Pedido no encontrado.");

    const orden = await prisma.orden.findFirst({
      where: { id: ordenId, cuentaClienteId: id },
      include: DETALLE_ORDEN_CUENTA_INCLUDE,
    });

    if (!orden) throw httpError(404, "Pedido no encontrado.");

    res.json(mapOrdenCuenta(orden));
  } catch (err) {
    next(err);
  }
}
