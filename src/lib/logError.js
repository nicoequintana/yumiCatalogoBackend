import { prisma } from "./prisma.js";
import { truncarTexto } from "./limitesTexto.js";
import { alertarError } from "../services/alertaErrores.service.js";

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
  const stackCompleto = stackConCausa(stack, causa);

  try {
    await prisma.errorLog.create({
      // `ruta` se recorta al largo de su columna (NVarChar(1000)): la URL la
      // arma el cliente, y una más larga hacía fallar justamente el insert del
      // log del error. `mensaje` y `stack` son NVarChar(Max), no lo necesitan.
      data: { mensaje, stack: stackCompleto, ruta: truncarTexto(ruta), metodo, status },
    });
  } catch (err) {
    console.error("logError: no se pudo persistir el ErrorLog:", err);
  }

  // El aviso por mail va DESPUÉS del insert y FUERA de su try: el insert es la
  // fuente de verdad, pero si falla el aviso importa MÁS, no menos — es el
  // único rastro que queda de que algo pasó.
  //
  // Solo 5xx. Un 4xx es el cliente pidiendo algo inválido, no una falla del
  // sistema: alertar por cada uno llenaría la casilla de ruido inaccionable, y
  // bastaría con un bot pegándole a rutas inexistentes para inundarla. Un error
  // SIN status es uno que nadie clasificó, así que se avisa por las dudas.
  //
  // `alertarError` nunca lanza (ver su docstring), pero el `catch` va igual:
  // este módulo no puede depender del contrato de otro para no romper el
  // manejo del error original.
  if (status === undefined || status === null || status >= 500) {
    try {
      await alertarError({ mensaje, stack: stackCompleto, ruta, metodo, status });
    } catch (err) {
      console.error("logError: no se pudo enviar la alerta:", err);
    }
  }
}
