/**
 * Chequeo básico de forma (`algo@algo.algo`), no una validación RFC completa.
 *
 * Vivía dentro de `usuarios.controller.js`, donde el email es el nombre de
 * login del admin. Al volverse obligatorio el email del cliente en el
 * checkout, el mismo chequeo hace falta en `ordenes.controller.js`: se
 * extrajo acá para que no haya dos regex que puedan divergir.
 *
 * La autoridad sobre duplicados sigue siendo el constraint único de la base;
 * esto solo descarta strings arbitrarios.
 */
const FORMATO_EMAIL = /^\S+@\S+\.\S+$/;

/**
 * @param {unknown} valor
 * @returns {boolean}
 */
export function esEmailValido(valor) {
  if (typeof valor !== "string") return false;
  return FORMATO_EMAIL.test(valor.trim());
}
