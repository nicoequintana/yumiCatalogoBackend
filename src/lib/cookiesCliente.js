import {
  COOKIE_DISPOSITIVO,
  COOKIE_SESION,
  DURACION_DISPOSITIVO_MS,
  DURACION_SESION_MS,
} from "./cuentasCliente.js";
import { cookieDominio } from "./env.js";

/**
 * Cookies de la sesión de CLIENTE (decisión 10 de la spec).
 *
 * `httpOnly` es lo que cambia respecto del admin: un XSS que logre ejecutar
 * no puede leerla, así que ya no depende de la CSP para no ser robada.
 *
 * `SameSite=Strict` funciona entre `yima-productos.com` y
 * `api.yima-productos.com`: "sitio" es el dominio registrable, no el host.
 * `Secure` en `http://localhost` lo permiten todos los navegadores.
 *
 * No hay `cookie-parser` en el proyecto y `npm install` está en `deny`:
 * `res.cookie()` es nativo de Express, pero leer cookies no, y por eso existe
 * `parsearCookies`.
 */

function atributosBase() {
  const domain = cookieDominio();
  return {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    ...(domain && { domain }),
  };
}

export function parsearCookies(headerCookie) {
  if (typeof headerCookie !== "string" || headerCookie === "") return {};
  const resultado = {};
  for (const par of headerCookie.split(";")) {
    const igual = par.indexOf("=");
    if (igual < 1) continue;
    const nombre = par.slice(0, igual).trim();
    if (nombre === "") continue;
    const crudo = par.slice(igual + 1).trim();
    let valor = crudo;
    try {
      valor = decodeURIComponent(crudo);
    } catch {
      valor = crudo;
    }
    resultado[nombre] = valor;
  }
  return resultado;
}

export function leerCookie(req, nombre) {
  const cookies = parsearCookies(req?.headers?.cookie);
  return Object.hasOwn(cookies, nombre) ? cookies[nombre] : null;
}

export function setCookieSesion(res, jwt) {
  res.cookie(COOKIE_SESION, jwt, { ...atributosBase(), maxAge: DURACION_SESION_MS });
}

/**
 * Para que el navegador BORRE una cookie, el `Set-Cookie` tiene que llevar
 * los mismos `Domain` y `Path` con los que se creó. Por eso no se usa
 * `res.clearCookie` pelado.
 */
export function borrarCookieSesion(res) {
  res.cookie(COOKIE_SESION, "", { ...atributosBase(), maxAge: 0 });
}

export function setCookieDispositivo(res, tokenClaro) {
  res.cookie(COOKIE_DISPOSITIVO, tokenClaro, { ...atributosBase(), maxAge: DURACION_DISPOSITIVO_MS });
}
