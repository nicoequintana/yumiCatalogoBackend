import { Decimal } from "@prisma/client/runtime/client.js";
import { redondearAEntero } from "./precios.js";
import { claveDiaArgentino, inicioDelDiaArgentino } from "./horarioArgentino.js";
import { esEnteroSeguro } from "./enteroSeguro.js";

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
 * Qué producto topea `alcanza`: el primero, en el orden recibido, cuyo
 * `floor(stock / cantidad)` iguala el mínimo. Alimenta "Lo limita X" del
 * editor (spec §8.3.3) — el frontend NO recalcula esto, lo lee resuelto de
 * `POST /admin/combos/cotizar`.
 *
 * @param {Array<{productId: number, stock: number, cantidad: number}>} items
 * @returns {number|null} el `productId` limitante, `null` con lista vacía
 */
export function productoLimitanteCombo(items) {
  if (items.length === 0) return null;

  let elegido = items[0];
  let menorAlcance = Math.floor(elegido.stock / elegido.cantidad);
  for (const item of items.slice(1)) {
    const alcance = Math.floor(item.stock / item.cantidad);
    if (alcance < menorAlcance) {
      elegido = item;
      menorAlcance = alcance;
    }
  }
  return elegido.productId;
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

  // `esEnteroSeguro` (no `Number.isInteger`) por el mismo gotcha que
  // `?campania=`/`?categoria=`: un `productId: 1e21` es "entero" para
  // `Number.isInteger` pero revienta a Prisma con "Unable to fit value
  // 1e+21 into a 64-bit signed integer" — un 500 en vez de este 400. Un
  // `productId` no numérico, fraccionario, cero, negativo o ausente
  // también se rechaza acá, ANTES de llegar a `exigirIdsExistentes`/Prisma.
  const idsValidos = items.every((item) => esEnteroSeguro(item?.productId) && item.productId > 0);
  if (!idsValidos) {
    errores.push("Cada producto necesita un `productId` válido.");
  }

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

/**
 * Reparte el precio del combo entre sus productos, en filas listas para
 * `ItemOrden` (por UNA unidad de combo, después escaladas por `comboCantidad`).
 *
 * Algoritmo (spec §5):
 *   1. `T` = `cuentasCombo(...).precioCombo` — la MISMA cuenta que se publica.
 *   2. Cada item: `u_i = redondearAEntero(precio_i × (100 − p) / 100)`.
 *   3. `r = T − Σ u_i × cantidad_i` (normalmente −1, 0 o +1 peso).
 *   4. Si `r ≠ 0`: se ajusta el item de mayor precio de lista con `cantidad = 1`;
 *      si no hay ninguno, el de mayor precio de lista se PARTE en dos filas —
 *      una unidad a `u_i + r`, `cantidad_i − 1` unidades a `u_i`.
 *   5. Cada fila se multiplica por `comboCantidad`.
 *
 * Solo son candidatas las filas que quedan > 0 después del ajuste; sin
 * ninguna, se rechaza: una fila en $0 no se persiste nunca.
 *
 * @param {Array<{productId: number, precio: Decimal|string|number, cantidad: number}>} items
 * @param {number} porcentaje
 * @param {number} [comboCantidad]
 */
export function repartirPrecioCombo(items, porcentaje, comboCantidad = 1) {
  const { precioCombo: total } = cuentasCombo(items, porcentaje);

  const filas = items.map((item) => ({
    productId: item.productId,
    precioListaUnitario: aDecimal(item.precio),
    precioUnitario: redondearAEntero(aDecimal(item.precio).mul(100 - porcentaje).div(100)),
    cantidad: item.cantidad,
  }));

  const sumaFilas = filas.reduce(
    (acumulado, fila) => acumulado.plus(fila.precioUnitario.mul(fila.cantidad)),
    new Decimal(0),
  );
  const resto = total.minus(sumaFilas);

  if (!resto.isZero()) {
    const mayorPrecio = (a, b) => (b.precioListaUnitario.gt(a.precioListaUnitario) ? b : a);
    const soportaAjuste = (fila) => fila.precioUnitario.plus(resto).gt(0);
    const candidatas = filas.filter(soportaAjuste);
    if (candidatas.length === 0) {
      throw new Error("No se puede repartir el precio del combo sin dejar una fila en $0.");
    }

    const unitarias = candidatas.filter((fila) => fila.cantidad === 1);
    if (unitarias.length > 0) {
      const elegida = unitarias.reduce(mayorPrecio);
      elegida.precioUnitario = elegida.precioUnitario.plus(resto);
    } else {
      const elegida = candidatas.reduce(mayorPrecio);
      filas.splice(
        filas.indexOf(elegida),
        1,
        { ...elegida, cantidad: 1, precioUnitario: elegida.precioUnitario.plus(resto) },
        { ...elegida, cantidad: elegida.cantidad - 1 },
      );
    }
  }

  return filas.map((fila) => ({
    productId: fila.productId,
    precioUnitario: fila.precioUnitario.toString(),
    precioListaUnitario: fila.precioListaUnitario.toString(),
    cantidad: fila.cantidad * comboCantidad,
  }));
}

/**
 * El `where` de Prisma de un combo vigente AHORA. Espejo de
 * `condicionPromocionVigente` (`lib/precioEfectivo.js`), pero más simple: un
 * combo no tiene programación individual, solo `SIEMPRE` o campañas.
 *
 * `activo` apagado gana siempre, esté o no en fecha — por eso va afuera del
 * `OR`, como condición propia.
 *
 * @param {Date} [ahora]
 */
export function condicionComboVigente(ahora = new Date()) {
  const medianocheDeHoy = inicioDelDiaArgentino(claveDiaArgentino(ahora));
  const enFecha = { desde: { lte: ahora }, hasta: { gte: medianocheDeHoy } };

  return {
    activo: true,
    OR: [
      { vigencia: "SIEMPRE" },
      { campanias: { some: { campania: { estado: "HABILITADA", ...enFecha } } } },
    ],
  };
}

/**
 * Evalúa en JS puro si un combo YA LEÍDO está vigente ahora — la contraparte
 * evaluable de `condicionComboVigente` (que arma un `where` de Prisma). Hace
 * falta para `GET /combos?ids=`, que trae combos por id sin filtrar por
 * vigencia (a propósito: el carrito necesita saber si un combo agregado antes
 * dejó de estar vigente) y necesita decidir el flag `vigente` sobre cada uno.
 *
 * @param {{activo: boolean, vigencia: string, campanias: Array<{campania: {estado: string, desde: Date, hasta: Date}}>}} combo
 * @param {Date} [ahora]
 */
export function esComboVigente(combo, ahora = new Date()) {
  if (!combo.activo) return false;
  if (combo.vigencia === "SIEMPRE") return true;

  const medianocheDeHoy = inicioDelDiaArgentino(claveDiaArgentino(ahora));
  return (combo.campanias ?? []).some(
    (c) =>
      c.campania.estado === "HABILITADA" &&
      c.campania.desde <= ahora &&
      c.campania.hasta >= medianocheDeHoy,
  );
}

/**
 * El encabezado de `/combos` ("Hasta N% off", "N combos disponibles"): cuántos
 * combos vigentes hay y el mayor porcentaje entre ellos. Lo resuelve el
 * backend (regla 1 de la metodología) y lo comparten `GET /combos/resumen` y
 * `/og/combos`, así el crawler y la persona leen el mismo número.
 *
 * @param {Array<{porcentaje: number}>} combos los VIGENTES, ya filtrados
 * @returns {{cantidad: number, porcentajeMaximo: number | null}}
 */
export function resumenCombos(combos) {
  if (!combos || combos.length === 0) return { cantidad: 0, porcentajeMaximo: null };
  return { cantidad: combos.length, porcentajeMaximo: Math.max(...combos.map((c) => c.porcentaje)) };
}
