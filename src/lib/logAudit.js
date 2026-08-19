import { prisma } from "./prisma.js";

/**
 * Serializa el `detalle` a string para persistirlo en una columna de texto.
 *
 * Un `detalle` que ya viene como string se guarda tal cual (permite resúmenes
 * cortos tipo `"PENDIENTE -> CONFIRMADA"` sin envolverlos en JSON). Cualquier
 * otra cosa se pasa por `JSON.stringify`, con catch propio: un objeto con
 * referencia circular haría throw y esta función no puede fallar nunca (ver
 * el doc-comment de `logAudit`). En ese caso el detalle se pierde, pero el
 * registro de auditoría se escribe igual — perder el detalle es mucho menos
 * grave que perder la traza entera.
 */
function serializarDetalle(detalle) {
  if (detalle === undefined || detalle === null) return null;
  if (typeof detalle === "string") return detalle;
  try {
    return JSON.stringify(detalle);
  } catch {
    return null;
  }
}

/**
 * Best-effort audit logger — persiste una mutación del admin en la tabla
 * `AuditLog` (quién hizo qué, cuándo, desde dónde).
 *
 * Mismo contrato que `logError.js`: NUNCA lanza. Una falla al auditar no
 * puede romper una mutación que el cliente ya dio por exitosa. Los callers lo
 * usan fire-and-forget (sin await) para que la respuesta HTTP no espere el
 * insert. Si el insert falla, cae a `console.error` puramente como rastro de
 * último recurso, nunca como camino principal.
 *
 * Se invoca SOLO después de que la mutación haya sido exitosa — nunca antes,
 * para que la traza no registre cambios que terminaron revirtiéndose.
 *
 * `usuarioEmail` se copia como snapshot en el momento de escribir (no es una
 * FK a `Usuario`): la traza tiene que sobrevivir al borrado del usuario admin.
 * Si el request no trae identidad (token viejo sin el claim `email`), se
 * escribe `"desconocido"` en vez de descartar el registro — una traza
 * incompleta sigue siendo mejor que ninguna traza.
 *
 * Nunca recibe ni persiste secretos: para `Usuario` se audita solo id/email,
 * jamás el `passwordHash`.
 *
 * @param {import("express").Request} req request ya pasado por `requireAuth` (aporta `req.usuario`, ruta, método e IP)
 * @param {object} params
 * @param {string} params.accion CREAR | ACTUALIZAR | ELIMINAR (+ variantes por recurso)
 * @param {string} params.entidad Producto | Orden | Usuario | Categoria
 * @param {number} [params.entidadId]
 * @param {object|string} [params.detalle] resumen de lo que cambió (objeto -> JSON, string -> tal cual)
 * @returns {Promise<void>}
 */
export async function logAudit(req, { accion, entidad, entidadId, detalle }) {
  try {
    await prisma.auditLog.create({
      data: {
        usuarioId: req?.usuario?.id ?? null,
        usuarioEmail: req?.usuario?.email ?? "desconocido",
        accion,
        entidad,
        entidadId: entidadId ?? null,
        detalle: serializarDetalle(detalle),
        ruta: req?.originalUrl ?? null,
        metodo: req?.method ?? null,
        ip: req?.ip ?? null,
      },
    });
  } catch (err) {
    console.error("logAudit: no se pudo persistir el AuditLog:", err);
  }
}
