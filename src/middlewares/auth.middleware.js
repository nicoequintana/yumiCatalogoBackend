import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";

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
 * ¿El usuario del token fue borrado de la base?
 *
 * Existe para que borrar un admin desde `/catalogo/admin/usuarios` le revoque
 * el acceso YA, no dentro de 7 días cuando expire su JWT — el caso de uso
 * típico de borrar un usuario es exactamente quitarle el acceso. Sin esto,
 * `requireAuth` nunca consultaba la base y un admin eliminado seguía operando
 * con todos los permisos hasta que su token venciera.
 *
 * Costo consciente: una consulta por request CON token (`findUnique` por PK
 * trayendo solo `{ id }` sobre una tabla de un puñado de filas). Las requests
 * anónimas del catálogo público no pagan nada — sin token no hay nada que
 * verificar. Se descartó un `tokenVersion` en `Usuario`: exige migración y
 * más código para el mismo resultado con este volumen de tráfico admin.
 *
 * FAIL-OPEN deliberado: solo la respuesta definitiva de Prisma (`null` = la
 * fila no existe) revoca. Si la consulta falla (base caída, timeout), se deja
 * pasar: cortar acá convertiría un hipo de DB en un logout masivo, y la
 * operación real va a fallar igual contra esa misma base con su propio error.
 * Un `id` no numérico (token viejo con `sub` raro) tampoco revoca — no hay
 * fila que buscar y el login real siempre firma `sub` con el id numérico.
 */
async function usuarioFueBorrado(usuario) {
  if (!Number.isInteger(usuario.id)) return false;
  try {
    const fila = await prisma.usuario.findUnique({
      where: { id: usuario.id },
      select: { id: true },
    });
    return fila === null;
  } catch {
    return false;
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
 * responde `401` directo, sin llamar a `next()`. Un token válido de un usuario
 * BORRADO también es 401 (ver `usuarioFueBorrado`) — mismo cuerpo que un token
 * inválido, para no confirmar desde afuera si una cuenta existió.
 */
export async function requireAuth(req, res, next) {
  const usuario = identidadDesdeToken(req);

  if (!usuario || (await usuarioFueBorrado(usuario))) {
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
export async function authOpcional(req, _res, next) {
  const usuario = identidadDesdeToken(req);
  // El chequeo de existencia también aplica acá: sin él, el token de un admin
  // BORRADO seguiría marcando la request como admin (`esRequestDeAdmin`) y
  // mostrando productos ocultos hasta expirar. Pero el resultado nunca corta
  // la request: "tu usuario ya no existe" degrada a anónimo, igual que un
  // token vencido — este es el catálogo público.
  if (usuario && !(await usuarioFueBorrado(usuario))) req.usuario = usuario;
  next();
}

/**
 * ¿Esta request habla en nombre de un admin?
 *
 * Sale de `req.usuario`, que solo puebla `authOpcional` (o `requireAuth`) tras
 * VERIFICAR el JWT (firma + expiración + `algorithms: ["HS256"]`). Nunca de la
 * querystring.
 *
 * Antes era `req.query.admin !== undefined`, y eso convertía `?admin=1` en una
 * llave maestra: alcanzaba con agregarlo a la URL para listar productos ocultos
 * y agotados, y para saltear el 404 de la ficha de un producto oculto. El
 * parámetro ni siquiera había que adivinarlo — lo escribe
 * `frontend/src/api/products.js`, que viaja en el bundle público.
 *
 * `?admin=1` sigue viajando desde el frontend, pero YA NO DECIDE NADA sobre qué
 * datos se devuelven: queda como señal de intención, útil para leer los logs y
 * —sobre todo— para que la respuesta admin y la pública no compartan URL, así
 * ningún intermediario que cachee por URL puede servirle a un visitante una
 * respuesta que se armó para un admin.
 *
 * Vive acá, junto al middleware que ESCRIBE `req.usuario`, y no dentro de un
 * controller: lo consultan tanto el CRUD público de producto como el proxy de
 * media, y una regla de acceso duplicada en dos módulos es una regla que en
 * algún momento va a divergir en uno solo de los dos.
 */
export function esRequestDeAdmin(req) {
  return Boolean(req.usuario);
}
