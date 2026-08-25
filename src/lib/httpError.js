/**
 * Crea un `Error` con `status` HTTP adosado, listo para `throw` dentro de un
 * controller.
 *
 * El contrato es el que espera el manejador global de errores
 * (`middlewares/errorHandler.js`): si el error trae `status`, ese es el código
 * de la respuesta y su `message` viaja tal cual al cliente; si no lo trae, cae
 * al 500 con mensaje enmascarado. Por eso este helper es la ÚNICA forma
 * correcta de responder un 4xx desde un controller — un `throw new Error(...)`
 * pelado termina siendo un 500 opaco.
 *
 * Estaba copiado byte a byte en seis controllers (products, ordenes,
 * categorias, usuarios, auth y eventos); vive acá para que el contrato con el
 * manejador de errores tenga un solo dueño.
 *
 * @param {number} status - código HTTP de la respuesta
 * @param {string} message - mensaje que verá el cliente
 * @returns {Error & { status: number }}
 */
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
