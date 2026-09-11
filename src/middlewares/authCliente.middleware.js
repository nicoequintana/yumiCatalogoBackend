import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { COOKIE_SESION } from "../lib/cuentasCliente.js";
import { borrarCookieSesion, leerCookie } from "../lib/cookiesCliente.js";
import { verificarSesionCliente } from "../lib/jwtCliente.js";

/**
 * Autenticación de CLIENTE. NO es un espejo del middleware de admin: hay dos
 * ramas de `estadoDeSesion` que allá son inofensivas y acá serían catastróficas.
 *
 * Rama 1 — `sub` no entero. El admin devuelve `{ revocada: false }` y sigue;
 * acá `cuentaClienteId: undefined` en un `where` hace que Prisma descarte la
 * clave y devuelva TODAS las órdenes del sistema. La rechaza `jwtCliente.js`
 * y acá se vuelve a afirmar.
 *
 * Rama 2 — error de la consulta. El admin es fail-OPEN por disponibilidad.
 * Acá es fail-CLOSED, pero DISTINGUIENDO: "no sos vos" es 401 con la cookie
 * borrada; "no pude verificar" es 503 con la cookie intacta. Si los dos fueran
 * 401, un hipo de 3 s de la base destruiría una credencial válida en pleno
 * checkout y mandaría a la persona a un login que también necesita la base.
 */

const SELECT_SESION = { id: true, email: true, tokenVersion: true, emailVerificado: true };

function sesionInvalida(res) {
  borrarCookieSesion(res);
  const err = httpError(401, "No autorizado.");
  err.codigo = "SESION_INVALIDA";
  return err;
}

function verificacionNoDisponible() {
  const err = httpError(503, "No pudimos verificar tu sesión, reintentá.");
  err.codigo = "VERIFICACION_NO_DISPONIBLE";
  return err;
}

/**
 * Resuelve la identidad de la request.
 * Devuelve `{ estado: "anonimo" }`, `{ estado: "ok", cuenta }`,
 * `{ estado: "invalida" }` o lanza el 503.
 */
async function resolverIdentidad(req) {
  const token = leerCookie(req, COOKIE_SESION);
  if (!token) return { estado: "anonimo" };

  const claims = verificarSesionCliente(token);
  if (!claims || !Number.isInteger(claims.id)) return { estado: "invalida" };

  let fila;
  try {
    fila = await prisma.cuentaCliente.findUnique({ where: { id: claims.id }, select: SELECT_SESION });
  } catch {
    throw verificacionNoDisponible();
  }

  if (!fila) return { estado: "invalida" };
  if (fila.tokenVersion !== claims.tokenVersion) return { estado: "invalida" };
  if (!fila.emailVerificado) return { estado: "invalida" };

  return { estado: "ok", cuenta: { id: fila.id, email: fila.email } };
}

export async function requireCliente(req, res, next) {
  try {
    const identidad = await resolverIdentidad(req);
    if (identidad.estado !== "ok") throw sesionInvalida(res);
    req.cuentaCliente = identidad.cuenta;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Para `POST /ordenes` con el flag apagado: con sesión toma los datos de la
 * cuenta; sin sesión sigue el camino de invitado. Una cookie INVÁLIDA degrada
 * a anónimo (y se borra); la base caída NO degrada — sería comprar como
 * invitado por accidente.
 */
export async function authClienteOpcional(req, res, next) {
  try {
    const identidad = await resolverIdentidad(req);
    if (identidad.estado === "ok") {
      req.cuentaCliente = identidad.cuenta;
    } else if (identidad.estado === "invalida") {
      borrarCookieSesion(res);
    }
    next();
  } catch (err) {
    next(err);
  }
}
