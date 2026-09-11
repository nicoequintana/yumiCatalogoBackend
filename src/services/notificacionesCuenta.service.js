import { enviarMail } from "./email.service.js";
import { logError } from "../lib/logError.js";
import { emitirToken } from "../lib/tokensCuenta.js";
import { TIPOS_TOKEN } from "../lib/cuentasCliente.js";
import {
  plantillaVerificacionEmail,
  plantillaCodigoAcceso,
  plantillaResetPassword,
  plantillaCambioEmail as armarPlantillaCambioEmail,
  plantillaAvisoCambioEmail as armarPlantillaAvisoCambioEmail,
  plantillaYaTenesCuenta,
} from "../lib/plantillasEmail.js";

/**
 * Capa de reglas del correo de cuenta: a quién, con qué plantilla, y qué pasa
 * si falla. Mismo criterio que `notificacionesOrden.service.js`: TODAS
 * fire-and-forget salvo `enviarReset`, que tiene una persona esperando del
 * otro lado del reseteo y no puede perderse por un hipo transitorio de Gmail.
 *
 * Tercera copia (a propósito) de la normalización de `FRONTEND_URL` sin barra
 * final: `lib/urlsPublicas.js` sirve SEO, `notificacionesOrden.service.js`
 * sirve órdenes, esta sirve cuenta — tres superficies de riesgo distintas.
 */
function urlSitio() {
  return (process.env.FRONTEND_URL ?? "").replace(/\/+$/, "");
}

/** Emite el token de verificación y lo manda. Nunca lanza. */
export async function enviarVerificacion(cuenta) {
  try {
    const { tokenClaro } = await emitirToken({ cuentaClienteId: cuenta.id, tipo: TIPOS_TOKEN.VERIFICACION });
    const mail = plantillaVerificacionEmail({ nombre: cuenta.nombre, tokenClaro }, { urlSitio: urlSitio() });
    await enviarMail({ para: cuenta.email, categoria: "resto", ...mail });
  } catch (err) {
    logError({ mensaje: `No se pudo enviar la verificación a ${cuenta.email}`, stack: err.stack, causa: err });
  }
}

/** El código ya viene generado (`emitirCodigoAcceso`, Parte 2b). Nunca lanza. */
export async function enviarCodigoAcceso(cuenta, codigo) {
  try {
    const mail = plantillaCodigoAcceso({ codigo }, { urlSitio: urlSitio() });
    await enviarMail({ para: cuenta.email, categoria: "acceso", ...mail });
  } catch (err) {
    logError({ mensaje: `No se pudo enviar el código de acceso a ${cuenta.email}`, stack: err.stack, causa: err });
  }
}

/**
 * El único mail con reintento: 3 intentos, backoff 2 s / 8 s. Sin retraso
 * antes del primero — el reintento es para el hipo de Gmail, no para retrasar
 * a alguien que está esperando poder entrar.
 */
export async function enviarReset(cuenta, tokenClaro) {
  const esperas = [0, 2000, 8000];
  let ultimoError;
  for (const espera of esperas) {
    if (espera > 0) await new Promise((resolver) => setTimeout(resolver, espera));
    try {
      const mail = plantillaResetPassword({ tokenClaro }, { urlSitio: urlSitio() });
      await enviarMail({ para: cuenta.email, categoria: "acceso", ...mail });
      return;
    } catch (err) {
      ultimoError = err;
    }
  }
  logError({
    mensaje: `No se pudo enviar el reset a ${cuenta.email} tras 3 intentos`,
    stack: ultimoError?.stack,
    causa: ultimoError,
  });
}

/** Va a la dirección NUEVA. Nunca lanza. */
export async function enviarCambioEmail(cuenta, { emailNuevo, tokenClaro }) {
  try {
    const mail = armarPlantillaCambioEmail({ tokenClaro }, { urlSitio: urlSitio() });
    await enviarMail({ para: emailNuevo, categoria: "resto", ...mail });
  } catch (err) {
    logError({
      mensaje: `No se pudo enviar la confirmación de cambio de email a ${emailNuevo}`,
      stack: err.stack,
      causa: err,
    });
  }
}

/** Va a la dirección VIEJA (la de la cuenta, antes del cambio). Nunca lanza. */
export async function enviarAvisoCambioEmail(cuenta, { emailNuevo }) {
  try {
    const mail = armarPlantillaAvisoCambioEmail({ emailNuevo }, { urlSitio: urlSitio() });
    await enviarMail({ para: cuenta.email, categoria: "resto", ...mail });
  } catch (err) {
    logError({
      mensaje: `No se pudo enviar el aviso de cambio de email a ${cuenta.email}`,
      stack: err.stack,
      causa: err,
    });
  }
}

/** Recibe el email a secas (no la fila): lo llama el registro cuando la cuenta YA existe. Nunca lanza. */
export async function enviarYaTenesCuenta(email) {
  try {
    const mail = plantillaYaTenesCuenta({}, { urlSitio: urlSitio() });
    await enviarMail({ para: email, categoria: "resto", ...mail });
  } catch (err) {
    logError({ mensaje: `No se pudo enviar el aviso de cuenta existente a ${email}`, stack: err.stack, causa: err });
  }
}
