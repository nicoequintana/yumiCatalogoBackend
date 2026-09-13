/**
 * Valida que `valor` sea una URL con protocolo `https:`.
 *
 * La usa `config.controller.js` para `instagramUrl`/`facebookUrl`/`tiktokUrl`
 * de `ConfiguracionContacto`: sin este chequeo, un `http://`, un `javascript:`
 * o un `data:` guardados a mano llegarían intactos hasta el link que el
 * catálogo público arma con esos valores. Rechaza además cualquier string que
 * `URL` no pueda parsear.
 *
 * No valida que el dominio pertenezca a la red social declarada — eso queda
 * fuera de scope, mismo criterio que `emailValido.js` no valida que el
 * dominio del email exista.
 *
 * @param {unknown} valor
 * @returns {boolean}
 */
export function esUrlHttpsValida(valor) {
  if (typeof valor !== "string") return false;
  try {
    const url = new URL(valor.trim());
    return url.protocol === "https:";
  } catch {
    return false;
  }
}
