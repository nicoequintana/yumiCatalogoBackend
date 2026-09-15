import { Decimal } from "@prisma/client/runtime/client.js";
import { redondearAEntero } from "./precios.js";

/**
 * Combos: conjuntos de productos con un descuento que se aplica SOLO si se
 * compra el conjunto entero. Única casa de las reglas puras — sin Prisma,
 * testeadas solas. El controller (`combos.controller.js`) las consume, nunca
 * las reimplementa.
 */

/** Lista ejecutable de `Combo.vigencia`. Columna `VarChar`, sin enum de Prisma. */
export const VIGENCIAS = ["SIEMPRE", "CAMPANIA"];

/** Unidades mínimas y máximas de un combo. Cada `cantidad` cuenta como tantas unidades. */
export const MIN_UNIDADES = 2;
export const MAX_UNIDADES = 10;

/** Espejan `NVarChar(140)`/`NVarChar(120)`. */
export const LARGO_MAX_FRASE = 140;
export const LARGO_MAX_NOMBRE = 120;

/**
 * "Quedan pocos": mismo predicado `<= 3` que `FichaProducto.jsx`/`ProductCard.jsx`
 * y `seo.cuerpo.js`. Es una copia más del umbral de stock bajo, registrada en
 * `docs/reglas/sincronizaciones.md`, y vive SOLO en el backend: el frontend
 * pinta `quedanPocos` resuelto.
 */
export const UMBRAL_QUEDAN_POCOS = 3;

/**
 * Normaliza a `Decimal` un precio que puede llegar como `Decimal` (Prisma),
 * string o number. `aDecimal` de `lib/precioEfectivo.js` es privada del
 * módulo; exportarla desde allá acoplaría las promociones a los combos por un
 * helper de dos líneas.
 */
function aDecimal(valor) {
  const crudo = typeof valor === "object" && valor !== null ? valor.toString() : valor;
  return new Decimal(crudo);
}

/**
 * Las cuentas del combo, sobre los precios de LISTA (las promociones de los
 * productos NO se tienen en cuenta — decisión explícita del negocio).
 *
 * @param {Array<{precio: Decimal|string|number, cantidad: number}>} items
 * @param {number} porcentaje - entero 5-50
 * @returns {{precioSeparado: Decimal, precioCombo: Decimal, ahorro: Decimal, unidades: number}}
 */
export function cuentasCombo(items, porcentaje) {
  const precioSeparado = items.reduce(
    (total, item) => total.plus(aDecimal(item.precio).mul(item.cantidad)),
    new Decimal(0),
  );
  const precioCombo = redondearAEntero(precioSeparado.mul(100 - porcentaje).div(100));
  const unidades = items.reduce((total, item) => total + item.cantidad, 0);

  return { precioSeparado, precioCombo, ahorro: precioSeparado.minus(precioCombo), unidades };
}

/**
 * Con cuántos combos alcanza el stock actual: el mínimo, entre todos los
 * items, de `floor(stock / cantidad)`. Nunca negativo.
 *
 * @param {Array<{stock: number, cantidad: number}>} items
 * @returns {number}
 */
export function alcanzaCombo(items) {
  return Math.max(0, Math.min(...items.map((item) => Math.floor(item.stock / item.cantidad))));
}

/**
 * La disponibilidad pública del combo (spec §3.4): `disponible` exige todos
 * los productos visibles y `alcanza >= 1`; `quedanPocos` solo tiene sentido
 * con stock (sin stock el chip es "Agotado").
 *
 * @param {Array<{stock: number, cantidad: number, visibleEnCatalogo: boolean}>} items
 * @returns {{alcanza: number, disponible: boolean, quedanPocos: boolean}}
 */
export function disponibilidadCombo(items) {
  const alcanza = alcanzaCombo(items);
  const todosVisibles = items.every((item) => item.visibleEnCatalogo);
  return {
    alcanza,
    disponible: todosVisibles && alcanza >= 1,
    quedanPocos: alcanza >= 1 && alcanza <= UMBRAL_QUEDAN_POCOS,
  };
}

/**
 * Errores legibles de la composición de un combo. Array vacío = válida.
 *
 * No tira: el controller decide el 400 con el primer mensaje, igual que
 * `detectarConflictos` es puro y no lanza.
 *
 * @param {Array<{productId: number, cantidad: number}>} items
 * @returns {string[]}
 */
export function validarComposicion(items) {
  if (!Array.isArray(items)) return ["Enviá la lista de productos del combo."];

  const errores = [];

  const cantidadesValidas = items.every(
    (item) => Number.isInteger(item?.cantidad) && item.cantidad >= 1,
  );
  if (!cantidadesValidas) {
    errores.push("Cada producto necesita una cantidad entera de al menos 1 unidad.");
  }

  if (cantidadesValidas) {
    const unidades = items.reduce((total, item) => total + item.cantidad, 0);
    if (unidades < MIN_UNIDADES) {
      errores.push(`Un combo necesita al menos ${MIN_UNIDADES} unidades entre todos sus productos.`);
    }
    if (unidades > MAX_UNIDADES) {
      errores.push(`Un combo admite como máximo ${MAX_UNIDADES} unidades entre todos sus productos.`);
    }
  }

  const ids = items.map((item) => item?.productId);
  if (new Set(ids).size !== ids.length) {
    errores.push("Hay un producto repetido en el combo.");
  }

  return errores;
}
