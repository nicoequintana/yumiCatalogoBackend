import { createHash, randomBytes, randomInt } from "node:crypto";
import { prisma } from "./prisma.js";
import { DURACION_TOKEN_MS, MAX_INTENTOS_CODIGO, TIPOS_TOKEN } from "./cuentasCliente.js";

/**
 * Tokens de un solo uso de las cuentas de cliente: verificación de email,
 * reseteo de contraseña, cambio de email y código de acceso.
 *
 * Tres reglas, y las tres tienen un ataque detrás:
 *
 * 1. El token en claro SOLO existe en el mail. En la base va su SHA-256:
 *    quien lea la base no puede verificar cuentas ajenas ni resetear
 *    contraseñas.
 * 2. El consumo es una ESCRITURA guardada — `updateMany` con `tipo`,
 *    `usadoEn: null` y `expiraEn > now` en el `where` — y la lectura de la fila
 *    va DESPUÉS. `updateMany` no devuelve la fila, por eso hace falta el
 *    segundo paso; y por eso nunca va primero: `findUnique` + `if` + `update`
 *    es el TOCTOU de `stockDescontado`, y en `/restablecer` es un replay.
 * 3. El `tipo` va SIEMPRE en el `where`. Sin él, un VERIFICACION de 24 h que
 *    viaja en cada mail de pedido sirve como RESET de 1 h.
 */

const DIAS_RETENCION_VENCIDOS = 30;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

const TIPOS_VALIDOS = new Set(Object.values(TIPOS_TOKEN));

export function hashDeToken(tokenClaro) {
  return createHash("sha256").update(tokenClaro).digest("hex");
}

/**
 * Seis dígitos colisionan entre cuentas y `tokenHash` es @unique: el hash
 * lleva el id de la cuenta adelante.
 */
export function hashDeCodigo(cuentaClienteId, codigo) {
  return hashDeToken(`${cuentaClienteId}:${codigo}`);
}

function exigirTipo(tipo) {
  if (!TIPOS_VALIDOS.has(tipo)) {
    throw new Error(`Tipo de token desconocido: ${tipo}`);
  }
}

/** Sin cron: cada emisión barre lo vencido hace más de 30 días. Nunca lanza. */
function limpiarVencidos() {
  const limite = new Date(Date.now() - DIAS_RETENCION_VENCIDOS * MS_POR_DIA);
  return prisma.tokenCuenta.deleteMany({ where: { expiraEn: { lt: limite } } }).catch(() => {});
}

export async function emitirToken({ cuentaClienteId, tipo, emailNuevo = null }) {
  exigirTipo(tipo);
  const tokenClaro = randomBytes(32).toString("base64url");
  const expiraEn = new Date(Date.now() + DURACION_TOKEN_MS[tipo]);

  const fila = await prisma.tokenCuenta.create({
    data: { cuentaClienteId, tipo, tokenHash: hashDeToken(tokenClaro), emailNuevo, expiraEn },
  });
  await limpiarVencidos();

  return { tokenClaro, expiraEn, id: fila?.id };
}

/**
 * `anterioresA` (opcional): el `id` del token recién emitido. Se invalida
 * DESPUÉS de emitir el reemplazo (invalidar antes deja a la cuenta sin ningún
 * token válido si la emisión falla), y SOLO lo emitido antes que él: con el
 * viejo "todos menos el mío", dos pedidos concurrentes se invalidaban uno al
 * otro y la cuenta quedaba sin ningún link vivo. Con `id < nuevo`, el más
 * nuevo sobrevive siempre.
 */
export async function invalidarTokensDe(cuentaClienteId, tipo, { anterioresA } = {}) {
  exigirTipo(tipo);
  await prisma.tokenCuenta.updateMany({
    where: { cuentaClienteId, tipo, usadoEn: null, ...(anterioresA != null && { id: { lt: anterioresA } }) },
    data: { usadoEn: new Date() },
  });
}

/**
 * Revoca de un saque los tokens vivos de varios tipos. `cliente` es `prisma`
 * o el `tx` de una transacción: quien cambia una credencial (contraseña,
 * email) decide si la revocación va atómica con esa escritura. Un
 * CAMBIO_EMAIL pendiente que sobreviviera a un cambio de contraseña le
 * dejaría a quien secuestró la sesión confirmar el cambio más tarde.
 */
export async function revocarTokensPendientes(cliente, cuentaClienteId, tipos) {
  tipos.forEach(exigirTipo);
  await cliente.tokenCuenta.updateMany({
    where: { cuentaClienteId, tipo: { in: tipos }, usadoEn: null },
    data: { usadoEn: new Date() },
  });
}

/**
 * Consume por hash. Devuelve `{ ok: true, fila }` o `{ ok: false, motivo }`
 * con `motivo` en INVALIDO | USADO | VENCIDO — el usuario necesita saber si
 * tiene que pedir otro o si ya está hecho. La clasificación es una lectura
 * posterior y NO decide nada: la única decisión ya la tomó el `updateMany`.
 *
 * `cliente` (opcional, default `prisma`): el `tx` de una transacción, para
 * que el consumo y su clasificación queden adentro y un rollback lo deshaga.
 */
export async function consumirToken({ tokenClaro, tipo }, cliente = prisma) {
  exigirTipo(tipo);
  if (typeof tokenClaro !== "string" || tokenClaro === "") {
    return { ok: false, motivo: "INVALIDO" };
  }
  const tokenHash = hashDeToken(tokenClaro);
  const ahora = new Date();

  const { count } = await cliente.tokenCuenta.updateMany({
    where: { tokenHash, tipo, usadoEn: null, expiraEn: { gt: ahora } },
    data: { usadoEn: ahora },
  });

  const fila = await cliente.tokenCuenta.findUnique({ where: { tokenHash } });

  if (count === 1) {
    return { ok: true, fila };
  }
  if (!fila || fila.tipo !== tipo) return { ok: false, motivo: "INVALIDO" };
  if (fila.usadoEn) return { ok: false, motivo: "USADO" };
  if (fila.expiraEn <= ahora) return { ok: false, motivo: "VENCIDO" };
  return { ok: false, motivo: "INVALIDO" };
}

/** Crea primero e invalida DESPUÉS lo anterior al nuevo (mismo criterio que `invalidarTokensDe`). */
export async function emitirCodigoAcceso(cuentaClienteId) {
  const codigo = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiraEn = new Date(Date.now() + DURACION_TOKEN_MS.CODIGO_ACCESO);

  const fila = await prisma.tokenCuenta.create({
    data: {
      cuentaClienteId,
      tipo: TIPOS_TOKEN.CODIGO_ACCESO,
      tokenHash: hashDeCodigo(cuentaClienteId, codigo),
      expiraEn,
    },
  });
  await invalidarTokensDe(cuentaClienteId, TIPOS_TOKEN.CODIGO_ACCESO, { anterioresA: fila?.id });

  return { codigo, expiraEn };
}

/**
 * El intento se cuenta ANTES de comparar, con la cota en el `where`: con
 * seis dígitos la entropía no defiende y este contador sí. Si el incremento
 * no escribió nada, o no hay código vigente o se agotaron los intentos — en
 * los dos casos no se compara.
 */
export async function consumirCodigoAcceso({ cuentaClienteId, codigo }) {
  if (typeof codigo !== "string" || !/^\d{6}$/.test(codigo)) {
    return { ok: false };
  }
  const ahora = new Date();

  const intento = await prisma.tokenCuenta.updateMany({
    where: {
      cuentaClienteId,
      tipo: TIPOS_TOKEN.CODIGO_ACCESO,
      usadoEn: null,
      expiraEn: { gt: ahora },
      intentos: { lt: MAX_INTENTOS_CODIGO },
    },
    data: { intentos: { increment: 1 } },
  });
  if (intento.count === 0) return { ok: false };

  const consumo = await prisma.tokenCuenta.updateMany({
    where: {
      tokenHash: hashDeCodigo(cuentaClienteId, codigo),
      tipo: TIPOS_TOKEN.CODIGO_ACCESO,
      usadoEn: null,
      expiraEn: { gt: ahora },
    },
    data: { usadoEn: ahora },
  });

  return { ok: consumo.count === 1 };
}
