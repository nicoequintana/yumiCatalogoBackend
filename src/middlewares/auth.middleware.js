import jwt from "jsonwebtoken";

/**
 * Verificación compartida por `requireAuth` y `authOpcional`: lee el JWT de
 * `Authorization: Bearer <token>` y devuelve la identidad del admin
 * (`{ id, email }`), o `null` si no hay token o si no verifica.
 *
 * Existe para que los dos middlewares NO tengan cada uno su propio
 * `jwt.verify`: `algorithms: ["HS256"]` es la guarda contra alg confusion y no
 * puede divergir entre la puerta del admin y la lectura opcional del catálogo
 * público. Un solo lugar donde equivocarse en vez de dos.
 *
 * La normalización del payload también vive acá, así los dos caminos exponen
 * exactamente la misma forma de `req.usuario`.
 */
function identidadDesdeToken(req) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return null;

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    const id = Number(payload?.sub);
    return {
      id: Number.isInteger(id) ? id : null,
      email: typeof payload?.email === "string" ? payload.email : null,
    };
  } catch {
    return null;
  }
}

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
  const usuario = identidadDesdeToken(req);

  if (!usuario) {
    return res.status(401).json({ error: "No autorizado." });
  }

  req.usuario = usuario;
  next();
}

/**
 * Auth OPCIONAL para endpoints públicos que además tienen una vista
 * privilegiada: si viene un JWT válido, deja la identidad en `req.usuario`
 * igual que `requireAuth`; si no viene, o si no verifica, sigue de largo como
 * anónimo. Nunca corta la request.
 *
 * Lo usan `GET /products` y `GET /products/:id`, donde el modo admin (ver
 * ocultos y agotados) tiene que salir de un token verificado. Antes salía de
 * `?admin=1`, un parámetro de querystring que cualquiera podía escribir — y que
 * de hecho está en el bundle público del frontend, así que ni siquiera había
 * que adivinarlo.
 *
 * DECISIÓN: un token inválido o expirado NO responde 401 acá, degrada a
 * anónimo. Estos endpoints son el catálogo público: un visitante sin sesión es
 * el caso NORMAL, no el caso de error. Fallar la request por una credencial
 * que el llamador no necesitaba convierte un token viejo en una pantalla rota
 * — el admin cuyo token de 7 días venció mientras miraba `/coleccion` vería el
 * catálogo público caído en vez de, simplemente, el catálogo público. "No pude
 * probar quién sos" y "sos anónimo" son la misma respuesta en un endpoint
 * público.
 *
 * No se pierde nada de seguridad: un token que no verifica no otorga NADA, y
 * las rutas que sí exigen identidad (todas las mutaciones) siguen detrás de
 * `requireAuth`, que sigue respondiendo 401. La contrapartida es de UX y está
 * acotada: con el token vencido, el listado del admin muestra solo lo público
 * hasta que el admin toca cualquier acción autenticada, que sí da 401 y lo
 * manda a login.
 */
export function authOpcional(req, _res, next) {
  const usuario = identidadDesdeToken(req);
  if (usuario) req.usuario = usuario;
  next();
}
