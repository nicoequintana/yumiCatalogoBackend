import { prisma } from "./prisma.js";

/**
 * Serializa una causa arbitraria a texto.
 *
 * No siempre es un `Error`: el SDK de Cloudinary rechaza con un OBJETO PLANO
 * (`{ message, http_code }`), y justamente ese `http_code` es el dato que hace
 * falta para diagnosticar. Por eso el caso `object` se serializa entero en vez
 * de leerle `.message`.
 *
 * @param {unknown} causa
 * @returns {string}
 */
function describirCausa(causa) {
  if (causa instanceof Error) return causa.stack ?? `${causa.name}: ${causa.message}`;
  if (typeof causa === "object") {
    try {
      return JSON.stringify(causa);
    } catch {
      // Referencias circulares: mejor una descripción pobre que perder el log.
      return String(causa);
    }
  }
  return String(causa);
}

/**
 * Adosa la causa al final del stack persistido.
 *
 * `ErrorLog` NO tiene columna para `cause` y esta pasada no agrega migración,
 * así que la causa viaja dentro de `stack` (que es `NVarChar(Max)`, sin riesgo
 * de truncado). Importa: `cloudinary.service.js` envuelve el rechazo del SDK en
 * un `Error` real y le cuelga el original en `err.cause` para no perder el
 * `http_code`; sin esto ese dato moría en memoria y el operador veía en la base
 * un 502 sin la razón concreta de la falla.
 *
 * Sin causa devuelve el stack intacto — incluido `null`, que es un valor válido
 * para la columna.
 *
 * @param {string|null|undefined} stack
 * @param {unknown} causa
 * @returns {string|null|undefined}
 */
function stackConCausa(stack, causa) {
  if (causa === undefined || causa === null) return stack;
  return `${stack ?? ""}\nCaused by: ${describirCausa(causa)}`;
}

/**
 * Logger técnico best-effort — persiste en la tabla `ErrorLog`.
 *
 * A propósito nunca lanza: que falle el logueo no puede romper la respuesta HTTP
 * que el cliente ya recibió (o está por recibir). Quienes lo llaman lo hacen
 * fire-and-forget (sin `await`) para que la respuesta no espere al insert. Si el
 * insert falla, se cae a `console.error` como rastro de último recurso — nunca
 * como camino principal.
 *
 * @param {object} params
 * @param {string} params.mensaje
 * @param {string} [params.stack]
 * @param {unknown} [params.causa] - `err.cause`, si el error trae uno
 * @param {string} [params.ruta]
 * @param {string} [params.metodo]
 * @param {number} [params.status]
 * @returns {Promise<void>}
 */
export async function logError({ mensaje, stack, causa, ruta, metodo, status }) {
  try {
    await prisma.errorLog.create({
      data: { mensaje, stack: stackConCausa(stack, causa), ruta, metodo, status },
    });
  } catch (err) {
    console.error("logError: no se pudo persistir el ErrorLog:", err);
  }
}
