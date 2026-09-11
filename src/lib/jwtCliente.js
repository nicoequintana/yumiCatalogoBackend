import jwt from "jsonwebtoken";
import { DURACION_SESION } from "./cuentasCliente.js";

/**
 * Firma y verificación de la sesión de CLIENTE.
 *
 * Secreto propio (`JWT_SECRET_CLIENTE`), y no es una precaución: cierra un
 * agujero concreto. `auth.middleware.js` saca el `id` del claim `sub` y hace
 * `usuario.findUnique({ where: { id } })`. Con el mismo secreto, un cliente
 * con `sub: 3` y `tokenVersion: 0` entraría como el `Usuario` 3 con el panel
 * completo — ids autoincrementales desde 1 y `tokenVersion` default 0 hacen
 * de la colisión el caso normal. Con dos secretos, un token de cliente no
 * puede validar contra el admin ni aunque alguien borre el chequeo de `tipo`.
 * Fail-closed por construcción. El `tipo` va igual, como segunda barrera.
 */

const ALGORITMO = "HS256";
const TIPO = "cliente";

function secreto() {
  return process.env.JWT_SECRET_CLIENTE;
}

export function firmarSesionCliente({ id, email, tokenVersion }) {
  return jwt.sign({ sub: id, email, tokenVersion, tipo: TIPO }, secreto(), {
    algorithm: ALGORITMO,
    expiresIn: DURACION_SESION,
  });
}

/**
 * Devuelve `{ id, email, tokenVersion }` o `null`. Nunca lanza.
 *
 * `sub` tiene que ser un ENTERO. En el middleware de admin un `sub` raro no
 * habilita nada; acá `cuentaClienteId: undefined` en un `where` hace que
 * Prisma descarte la clave y devuelva todas las órdenes del sistema.
 */
export function verificarSesionCliente(token) {
  if (typeof token !== "string" || token === "") return null;
  try {
    const payload = jwt.verify(token, secreto(), { algorithms: [ALGORITMO] });
    if (payload?.tipo !== TIPO) return null;
    if (!Number.isInteger(payload.sub)) return null;
    if (!Number.isInteger(payload.tokenVersion)) return null;
    return { id: payload.sub, email: payload.email, tokenVersion: payload.tokenVersion };
  } catch {
    return null;
  }
}
