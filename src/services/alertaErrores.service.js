/**
 * Avisa por mail cuando entra un error técnico nuevo.
 *
 * POR QUÉ EXISTE. `ErrorLog` guardaba todo con disciplina, pero era **pull**:
 * había que entrar al panel y mirar. Las tres integraciones que pueden fallar
 * en silencio son justamente las que menos se ven —el mail de confirmación
 * (fire-and-forget por diseño), la subida a Cloudinary y el webhook de n8n—, y
 * un cliente que nunca recibió su comprobante no generaba ningún aviso.
 *
 * NUNCA LANZA, mismo contrato que `lib/logError.js` y `lib/logAudit.js`: esto
 * corre en el camino de un error que YA ocurrió. Una alerta que lanza convierte
 * un 500 registrado en un proceso caído.
 */
import { enviarMail } from "./email.service.js";

/**
 * Cuánto se espera entre dos avisos.
 *
 * Un fallo de Cloudinary o de la base no llega solo: llega como ráfaga. Sin
 * agrupación, un incidente de dos minutos manda cientos de mails, la casilla se
 * vuelve inservible y la alerta se empieza a ignorar — que es peor que no
 * tenerla. Cinco minutos alcanza para que un incidente se lea como uno solo y
 * es lo bastante corto para enterarse el mismo día.
 */
export const VENTANA_AGRUPACION_MS = 5 * 60 * 1000;

/** Cuánto stack entra en el mail. Un stack de Prisma son miles de caracteres. */
const MAX_STACK = 1200;

let ultimoEnvio = 0;
let suprimidos = 0;

/** Solo para tests: limpia el estado de agrupación entre casos. */
export function _resetearParaTests() {
  ultimoEnvio = 0;
  suprimidos = 0;
}

function cuerpo({ mensaje, stack, ruta, metodo, status }, omitidos) {
  const lineas = [
    `Se registró un error en el backend de YIMA.`,
    ``,
    `Mensaje: ${mensaje}`,
    `Ruta:    ${metodo ?? "—"} ${ruta ?? "—"}`,
    `Estado:  ${status ?? "—"}`,
    `Cuándo:  ${new Date().toISOString()}`,
  ];

  if (omitidos > 0) {
    lineas.push(
      ``,
      `Además hubo ${omitidos} error(es) más en los minutos previos que no se`,
      `avisaron para no inundar la casilla. Están todos en el panel:`,
      `/catalogo/admin/logs`,
    );
  }

  if (stack) {
    lineas.push(``, `Traza (recortada):`, stack.slice(0, MAX_STACK));
  }

  lineas.push(``, `El detalle completo está en /catalogo/admin/logs.`);
  return lineas.join("\n");
}

/**
 * Manda el aviso, si corresponde según la ventana de agrupación.
 *
 * @param {{mensaje: string, stack?: string, ruta?: string, metodo?: string, status?: number}} error
 * @returns {Promise<void>} siempre resuelve
 */
export async function alertarError(error) {
  try {
    const destino = process.env.MAIL_ADMIN_DESTINO;
    // Sin destino no hay a quién avisar. No es un fallo: la alerta es opcional
    // y el error ya quedó en `ErrorLog`, que es la fuente de verdad.
    if (!destino) return;

    const ahora = Date.now();
    if (ahora - ultimoEnvio < VENTANA_AGRUPACION_MS) {
      suprimidos += 1;
      return;
    }

    const omitidos = suprimidos;
    // Se marcan ANTES de enviar: si el envío tarda o falla, la ventana igual
    // corrió y no se dispara una ráfaga de reintentos.
    ultimoEnvio = ahora;
    suprimidos = 0;

    await enviarMail({
      para: destino,
      asunto: `[YIMA] Error en el backend: ${error.mensaje}`.slice(0, 180),
      texto: cuerpo(error, omitidos),
    });
  } catch {
    // Deliberadamente mudo: `logError` ya persistió el error original, que es
    // lo que importa. Loguear acá el fallo del aviso puede disparar otro aviso.
  }
}
