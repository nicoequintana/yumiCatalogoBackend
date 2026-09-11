import { crearLimitadorDeVelocidad } from "./rateLimit.middleware.js";
import { normalizarEmail } from "../lib/cuentasCliente.js";

/**
 * Los limitadores de las rutas de cuenta, en un módulo propio para que el
 * controller pueda importar la INSTANCIA (no solo la fábrica) cuando necesite
 * resetear una clave. `express-rate-limit` guarda el estado en la instancia.
 *
 * El contador por DESTINO (email) existe porque el tope por IP protege al
 * servidor, no a la cuenta: con 100 IPs hay 800 intentos contra una sola
 * cuenta dentro de todos los límites. Cuatro reglas, cada una con un ataque
 * detrás:
 * - se normaliza, o `Victima@Gmail.com` esquiva el balde de `victima@gmail.com`;
 * - se SALTEA si falta o es inválido, o un body `{}` comparte un balde para
 *   todo el mundo;
 * - se acota el largo antes de keyear, o un "email" de 90 KB queda una hora
 *   en memoria;
 * - el 429 lleva el MISMO cuerpo que el de IP, o el mensaje delata si la
 *   cuenta existe.
 */

const MINUTO = 60 * 1000;
const HORA = 60 * MINUTO;
const LARGO_MAX_CLAVE = 254;

export const MENSAJE_429_CUENTA =
  "Demasiados intentos. Probá de nuevo en unos minutos, o escribinos por WhatsApp si necesitás ayuda.";

export function claveDeDestino(req) {
  const email = normalizarEmail(req?.body?.email);
  if (email === "" || email.length > LARGO_MAX_CLAVE || !email.includes("@")) return null;
  return email;
}

export function crearLimitadorPorDestino({ windowMs, max }) {
  return crearLimitadorDeVelocidad({
    windowMs,
    max,
    message: MENSAJE_429_CUENTA,
    // El fallback "sin-destino" es inalcanzable en la práctica: `skip` de
    // abajo ya devuelve `true` (y `express-rate-limit` ni llama a
    // `keyGenerator`) exactamente cuando `claveDeDestino(req)` da `null`. Se
    // deja como red de seguridad explícita, no como código muerto a borrar.
    keyGenerator: (req) => claveDeDestino(req) ?? "sin-destino",
    skip: (req) => claveDeDestino(req) === null,
  });
}

function porIp({ windowMs, max }) {
  return crearLimitadorDeVelocidad({ windowMs, max, message: MENSAJE_429_CUENTA });
}

/** La tabla "Rate limiting" de la spec, instancia por instancia. */
export const limitadores = {
  registroIp: porIp({ windowMs: HORA, max: 15 }),
  registroDestino: crearLimitadorPorDestino({ windowMs: 24 * HORA, max: 3 }),
  loginIp: porIp({ windowMs: 15 * MINUTO, max: 8 }),
  codigoIp: porIp({ windowMs: 15 * MINUTO, max: 20 }),
  codigoReenviarIp: porIp({ windowMs: HORA, max: 5 }),
  codigoReenviarDestino: crearLimitadorPorDestino({ windowMs: HORA, max: 3 }),
  googleIp: porIp({ windowMs: 15 * MINUTO, max: 20 }),
  olvideIp: porIp({ windowMs: HORA, max: 5 }),
  olvideDestino: crearLimitadorPorDestino({ windowMs: HORA, max: 3 }),
  restablecerIp: porIp({ windowMs: HORA, max: 10 }),
  verificarIp: porIp({ windowMs: HORA, max: 10 }),
  reenviarVerificacionIp: porIp({ windowMs: HORA, max: 3 }),
  passwordIp: porIp({ windowMs: HORA, max: 10 }),
  emailIp: porIp({ windowMs: HORA, max: 10 }),
};
