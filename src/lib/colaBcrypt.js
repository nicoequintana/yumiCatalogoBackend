import { httpError } from "./httpError.js";

/**
 * Semáforo global para todo hash o compare de bcrypt.
 *
 * Es la única defensa contra el DoS por CPU que no depende de contar IPs
 * (Amenaza 9 de la spec): `bcryptjs` es JS puro y corre en el único proceso
 * Node del contenedor, el mismo que sirve el catálogo. Cien IPs dentro de
 * todos los límites por IP saturan un núcleo; cuando `/health` cae, EasyPanel
 * reinicia y los contadores en memoria vuelven a cero. Esta cola no se resetea
 * con nada que el atacante controle.
 *
 * Contrato con los handlers: `reservarSlot()` se llama AL TOPE, antes de
 * cualquier consulta a la base. Si se llamara después del `findUnique`, con
 * la cola llena "cuenta existente" daría 503 y "inexistente" 401 rápido — un
 * oráculo por código de estado que anula el señuelo del login.
 *
 * No hay slot reservado para el admin: `/auth/login` es anónimo y un botnet
 * saturaría esa cola dedicada igual. Bajo saturación el operador también
 * recibe 503; es un incidente y se atiende como tal.
 */

const CONCURRENCIA_POR_DEFECTO = 3;
const RETRY_AFTER_SEGUNDOS = 2;

let capacidad = leerCapacidad();
let enUso = 0;

function leerCapacidad() {
  const valor = Number.parseInt(process.env.BCRYPT_CONCURRENCIA ?? "", 10);
  return Number.isInteger(valor) && valor > 0 ? valor : CONCURRENCIA_POR_DEFECTO;
}

/**
 * Devuelve la función que libera el slot. Lanza un `httpError(503)` con
 * `codigo: "CAPACIDAD"` y `retryAfter` cuando no hay lugar — sin esperar en
 * cola: encolar sería acumular trabajo que el atacante paga gratis.
 */
export async function reservarSlot() {
  if (enUso >= capacidad) {
    const err = httpError(503, "Estamos recibiendo muchas solicitudes. Probá de nuevo en unos segundos.");
    err.codigo = "CAPACIDAD";
    err.retryAfter = RETRY_AFTER_SEGUNDOS;
    throw err;
  }
  enUso += 1;
  let liberado = false;
  return () => {
    if (liberado) return;
    liberado = true;
    enUso -= 1;
  };
}

/** Para saltear trabajo opcional (el rehash-al-entrar) cuando no sobra CPU. */
export function estaBajoPresion() {
  return enUso * 2 >= capacidad;
}

export function _reiniciarParaTests() {
  capacidad = leerCapacidad();
  enUso = 0;
}
