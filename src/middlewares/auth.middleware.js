import jwt from "jsonwebtoken";

/**
 * Protege las rutas del panel admin: exige un JWT válido en
 * `Authorization: Bearer <token>` y, además de dejar pasar, expone la
 * identidad del admin en `req.usuario` (`{ id, email }`).
 *
 * `req.usuario` existe para la traza de auditoría (`logAudit`): sin esto el
 * AuditLog no podría decir QUIÉN hizo cada mutación. El email viaja en el
 * propio payload del token (lo firma `auth.controller.js` en el login), no se
 * resuelve contra la DB — así ninguna request admin paga un round-trip extra
 * solo para poder loguear.
 *
 * Tokens emitidos ANTES de que el login agregara el claim `email` siguen
 * siendo válidos hasta que expiren (7 días): en ese caso `email` queda `null`
 * en vez de romper la request. Mismo criterio con un `sub` no numérico — se
 * normaliza a `null` en vez de propagar un `NaN` hacia la columna `usuarioId`.
 *
 * El comportamiento de 401 no cambia: token ausente, inválido o expirado
 * responde `401` directo, sin llamar a `next()`.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "No autorizado." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const id = Number(payload?.sub);
    req.usuario = {
      id: Number.isInteger(id) ? id : null,
      email: typeof payload?.email === "string" ? payload.email : null,
    };
    next();
  } catch {
    res.status(401).json({ error: "No autorizado." });
  }
}
