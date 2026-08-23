import { enviarMail } from "./email.service.js";
import { logError } from "../lib/logError.js";
import {
  plantillaCambioEstadoCliente,
  plantillaOrdenCreadaAdmin,
  plantillaOrdenCreadaCliente,
} from "../lib/plantillasEmail.js";

/**
 * Reglas de negocio del envío de correo de órdenes: a quién se le escribe,
 * con qué plantilla, y qué pasa cuando falla.
 *
 * Las dos funciones exportadas tratan el error de forma DISTINTA a propósito:
 *
 * - `notificarOrdenCreada` es fire-and-forget. La dispara el checkout público
 *   después de que la orden ya se creó, y perder una venta porque Gmail no
 *   responde es inaceptable. Nunca lanza; todo fallo va a `ErrorLog`.
 * - `notificarCambioEstado` REPORTA. La dispara el admin, hay una persona
 *   esperando el resultado y necesita saber si el cliente se enteró. Tampoco
 *   lanza —el estado ya se guardó y un error de correo no puede revertirlo—,
 *   pero devuelve qué pasó para que el panel lo muestre.
 */

/**
 * URL absoluta al detalle de la orden en el panel.
 *
 * Se le saca la barra final a `FRONTEND_URL` porque en EasyPanel es fácil
 * cargarla con una, y `https://yima.test//catalogo/...` es un link feo que
 * además rompe en algunos clientes de correo.
 */
function urlDeOrden(id) {
  const base = (process.env.FRONTEND_URL ?? "").replace(/\/+$/, "");
  return `${base}/catalogo/admin/ordenes/${id}`;
}

/**
 * Envía y traduce cualquier fallo a un resultado, registrándolo.
 *
 * `descripcion` es lo que va a leer el operador en `ErrorLog` para saber qué
 * mail no salió, así que nombra el destinatario y la orden.
 *
 * @returns {Promise<{enviada: boolean, error?: string}>}
 */
async function enviarYRegistrar({ para, plantilla, descripcion }) {
  try {
    await enviarMail({
      para,
      asunto: plantilla.asunto,
      texto: plantilla.texto,
      html: plantilla.html,
    });
    return { enviada: true };
  } catch (err) {
    // Fire-and-forget, igual que el resto de los loggers del proyecto: no se
    // espera el insert y su propia falla no puede propagarse.
    logError({
      mensaje: `No se pudo enviar el mail de ${descripcion}`,
      stack: err.stack,
      causa: err,
    });
    return { enviada: false, error: err.message };
  }
}

/**
 * Los dos mails del alta de una orden: comprobante al cliente y aviso a YIMA.
 *
 * Cada uno se envía por separado y con su propio manejo de error — que falle
 * el del cliente no puede impedir el de YIMA, ni al revés. `allSettled` y no
 * `all` por el mismo motivo que en `productoMedia.service.js`: `all` devuelve
 * el control al primer rechazo mientras el otro envío sigue en vuelo.
 *
 * NUNCA lanza.
 *
 * @param {object} orden - con `cliente` e `items` incluidos
 * @returns {Promise<void>}
 */
export async function notificarOrdenCreada(orden) {
  const envios = [];

  if (orden.cliente?.email) {
    envios.push(
      enviarYRegistrar({
        para: orden.cliente.email,
        plantilla: plantillaOrdenCreadaCliente(orden),
        descripcion: `confirmación de la orden ${orden.id} al cliente`,
      }),
    );
  }

  const destinoAdmin = process.env.MAIL_ADMIN_DESTINO;
  if (destinoAdmin) {
    envios.push(
      enviarYRegistrar({
        para: destinoAdmin,
        plantilla: plantillaOrdenCreadaAdmin(orden, { urlOrden: urlDeOrden(orden.id) }),
        descripcion: `aviso interno de la orden ${orden.id}`,
      }),
    );
  }

  await Promise.allSettled(envios);
}

/**
 * Aviso al cliente de que su orden cambió de estado. `orden.estado` ya es el
 * estado NUEVO.
 *
 * NUNCA lanza: devuelve el resultado para que el controller lo informe.
 *
 * @param {object} orden - con `cliente` e `items` incluidos
 * @returns {Promise<{intentada: boolean, enviada: boolean, error?: string}>}
 */
export async function notificarCambioEstado(orden) {
  const email = orden.cliente?.email;

  if (!email) {
    // No es un error de la operación: el estado se guardó igual. Es una orden
    // vieja, anterior a que el email fuera obligatorio en el checkout.
    return {
      intentada: false,
      enviada: false,
      error: "El cliente no tiene email registrado.",
    };
  }

  const resultado = await enviarYRegistrar({
    para: email,
    plantilla: plantillaCambioEstadoCliente(orden),
    descripcion: `cambio de estado de la orden ${orden.id}`,
  });

  return { intentada: true, ...resultado };
}
