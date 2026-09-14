import { httpError } from "../lib/httpError.js";

/**
 * Exige permiso de borrado para las rutas destructivas del panel.
 *
 * POR QUÉ EXISTE. El sistema no tiene roles —decisión consciente y correcta
 * cuando había un solo admin—, pero creció: hoy cualquier usuario del panel
 * puede borrar productos en lote, cambiar los precios de todo el catálogo y
 * eliminar a otros admin. Con la skill de carga automatizada operando con su
 * propio usuario, ya hay más de una identidad trabajando, y ninguna con
 * permisos acotados. `AuditLog` deja el rastro de quién hizo qué, que es más de
 * lo que tienen la mayoría de los sistemas de este tamaño — pero **auditoría no
 * es prevención**.
 *
 * NO ES RBAC y no pretende serlo. Es UN flag booleano sobre la única clase de
 * acción que no tiene vuelta atrás. Un sistema de roles completo para dos o
 * tres personas sería la abstracción de más que este proyecto evita en todo lo
 * demás.
 *
 * VA DESPUÉS DE `requireAuth`, que es quien puebla `req.usuario.puedeEliminar`
 * leyéndolo de la base en la misma consulta que ya hacía para verificar la
 * revocación de sesión. Sale de la BASE y no del JWT a propósito: quitarle el
 * permiso a alguien surte efecto en la request siguiente, no cuando expire su
 * token 24 horas después.
 */
export function requierePermisoDeBorrado(req, _res, next) {
  // Sin identidad la respuesta correcta es 401 y no 403: "no sé quién sos" es
  // distinto de "sé quién sos y no podés". Solo pasa si alguien monta este
  // middleware sin `requireAuth` delante.
  if (!req.usuario) {
    return next(httpError(401, "No autorizado."));
  }

  // FAIL-CLOSED: se exige `true` explícito. Si un camino nuevo dejara
  // `req.usuario` sin el campo, la respuesta segura es negar — asumir permiso
  // ante la duda es justo el agujero que este middleware existe para tapar.
  if (req.usuario.puedeEliminar !== true) {
    return next(
      httpError(403, "Tu usuario no tiene permiso para eliminar. Pedile a otro administrador que lo habilite."),
    );
  }

  next();
}

/**
 * Gatea `PUT /usuarios/:id` con el MISMO flag que `requierePermisoDeBorrado`,
 * pero solo cuando la request pide algo que ese flag tiene que cubrir (ver
 * H-01, `docs/reglas/seguridad-y-arranque.md` § "Permiso de borrado por
 * usuario"):
 *
 *  - Editar a OTRO usuario (cualquier campo, incluidos email/password) exige
 *    el permiso. Sin esto, un usuario sin `puedeEliminar` podía tomar la
 *    cuenta de otro admin con un `PUT` — no hay borrado de entidad de por
 *    medio, pero el resultado (control total de otra cuenta) es equivalente.
 *  - Tocar la PROPIA fila para cambiar `puedeEliminar` exige el permiso —
 *    otorgárselo a uno mismo es la escalada más directa. Cambiar el propio
 *    email o password NO lo exige: seguir pudiendo actualizar la propia
 *    credencial es edición normal, no una acción destructiva.
 *
 * Reusa `requierePermisoDeBorrado` en vez de repetir el chequeo `=== true`:
 * un solo lugar sabe qué significa "tener el permiso".
 */
export function requierePermisoParaActualizarUsuario(req, res, next) {
  if (!req.usuario) {
    return next(httpError(401, "No autorizado."));
  }

  const idObjetivo = Number(req.params.id);
  const esPropiaCuenta = req.usuario.id === idObjetivo;
  const tocaPuedeEliminar = Object.prototype.hasOwnProperty.call(req.body ?? {}, "puedeEliminar");

  if (!esPropiaCuenta || tocaPuedeEliminar) {
    return requierePermisoDeBorrado(req, res, next);
  }

  next();
}
