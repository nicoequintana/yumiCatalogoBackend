import { randomBytes } from "node:crypto";
import { prisma } from "./prisma.js";
import { httpError } from "./httpError.js";
import { logError } from "./logError.js";
import { LARGO_MAX_TEXTO } from "./limitesTexto.js";
import { DURACION_DISPOSITIVO_MS, HORAS_PURGA_NO_VERIFICADAS } from "./cuentasCliente.js";
import { hashDeToken } from "./tokensCuenta.js";
import { setCookieDispositivo } from "./cookiesCliente.js";

/**
 * Reglas de la cuenta de cliente que comparten más de un controller (los
 * cuatro de `/api/cuenta` y el panel admin). Viven acá para que la ventana de
 * 24 h, su purga y los guards de entrada no se redefinan en cada punta con
 * criterios que se desfasen.
 */

export const MS_PURGA_NO_VERIFICADAS = HORAS_PURGA_NO_VERIFICADAS * 60 * 60 * 1000;

/** Límite del índice UNIQUE de `CuentaCliente.email` (1700 bytes): más largo revienta el insert como 500. */
export const LARGO_MAX_EMAIL = 254;

/**
 * Un token real mide 43 caracteres (32 bytes en base64url). Lo que pase de
 * esto no se hashea: se responde como INVALIDO, sin gastar CPU en SHA-256
 * sobre un body de megas y sin un mensaje distinto que sirva de oráculo.
 */
export const LARGO_MAX_TOKEN = 128;

/** Un solo diccionario para todo link de un solo uso (verificar, restablecer y el camino operado). */
export const MENSAJES_TOKEN = {
  INVALIDO: "Ese link no es válido.",
  USADO: "Ese link ya se usó.",
  VENCIDO: "Ese link venció. Pedí uno nuevo.",
};

export function responderMotivo(res, motivo) {
  return res.status(400).json({ error: MENSAJES_TOKEN[motivo], motivo });
}

/**
 * `typeof === "string"` y el tope de 254 ANTES de normalizar, hashear o tocar
 * la base: un email que no es string (número, array, objeto) no puede llegar
 * a bcrypt ni a `normalizarEmail` sin explotar o mentir sobre su forma, y uno
 * más largo que el índice UNIQUE revienta el insert como 500.
 */
export function esEmailAdmisible(email) {
  return typeof email === "string" && email.length <= LARGO_MAX_EMAIL;
}

/**
 * Campo de texto obligatorio con el tope de su columna (`NVarChar(1000)`).
 * `siVacio` lo pone quien llama porque el mensaje difiere entre el alta ("es
 * obligatorio") y la edición del perfil ("no puede estar vacío").
 */
export function exigirTextoAcotado(valor, { etiqueta, siVacio }) {
  const texto = typeof valor === "string" ? valor.trim() : "";
  if (!texto) throw httpError(400, siVacio);
  if (texto.length > LARGO_MAX_TEXTO) {
    throw httpError(400, `${etiqueta} no puede superar los ${LARGO_MAX_TEXTO} caracteres.`);
  }
  return texto;
}

/**
 * Una NUNCA verificada cuenta como vencida pasadas las 24 h, aunque la purga
 * todavía no la haya borrado. Con `verificadaEn` puesto la ventana no aplica:
 * la reasignación operada del email apaga `emailVerificado` en un cliente
 * real, con pedidos, que no es un registro abandonado.
 */
export function estaFueraDeVentana(cuenta) {
  return cuenta.verificadaEn == null && Date.now() - cuenta.createdAt.getTime() > MS_PURGA_NO_VERIFICADAS;
}

/**
 * Marca la cuenta verificada con las guardas en el `where` (mismo criterio
 * que `stockDescontado`), en dos escrituras con `where` DISJUNTOS por
 * `verificadaEn`, cada una atómica por sí sola:
 *
 * 1. Primera verificación (`verificadaEn` NULL): exige estar dentro de la
 *    ventana de 24 h (o ya verificada) y setea `verificadaEn`.
 * 2. Ya verificada alguna vez (reasignada por el panel): sin ventana, y
 *    `verificadaEn` no se pisa.
 *
 * Una sola escritura más un "setear verificadaEn si es NULL" aparte dejaría,
 * si la segunda falla, una cuenta verificada con `verificadaEn` NULL: la
 * próxima reasignación la volvería purgable. Devuelve el `count`.
 */
export async function marcarVerificada(cuentaClienteId, datos = {}) {
  const primera = await prisma.cuentaCliente.updateMany({
    where: {
      id: cuentaClienteId,
      verificadaEn: null,
      OR: [{ emailVerificado: true }, { createdAt: { gte: new Date(Date.now() - MS_PURGA_NO_VERIFICADAS) } }],
    },
    data: { ...datos, emailVerificado: true, verificadaEn: new Date() },
  });
  if (primera.count > 0) return primera.count;
  const { count } = await prisma.cuentaCliente.updateMany({
    where: { id: cuentaClienteId, verificadaEn: { not: null } },
    data: { ...datos, emailVerificado: true },
  });
  return count;
}

/**
 * Un navegador que hace click en el link YA probó posesión del buzón: se le
 * ahorra el mail de código de acceso en su primer login (spec, "Verificación").
 *
 * Best-effort: la cuenta ya quedó verificada. Si esto falla, lo único que se
 * pierde es el atajo — el primer login pedirá código —, así que se loguea y
 * la verificación responde igual.
 */
export async function marcarDispositivoConocido(res, cuentaClienteId) {
  try {
    const tokenClaro = randomBytes(32).toString("base64url");
    await prisma.dispositivoConocido.create({
      data: {
        cuentaClienteId,
        tokenHash: hashDeToken(tokenClaro),
        expiraEn: new Date(Date.now() + DURACION_DISPOSITIVO_MS),
      },
    });
    setCookieDispositivo(res, tokenClaro);
  } catch (err) {
    logError({ mensaje: `No se pudo registrar el dispositivo conocido de la cuenta ${cuentaClienteId}`, stack: err.stack, causa: err });
  }
}

/**
 * Hermano de `exigirTextoAcotado` para campos de texto REALMENTE opcionales,
 * de los que además hace falta poder BORRAR el valor (el apodo del perfil):
 * `exigirTextoAcotado` tira 400 ante un valor vacío, así que sirve para
 * campos obligatorios pero no para uno que la persona tiene que poder dejar
 * en blanco sin que eso sea un error.
 *
 * Vacío, solo espacios, `null` o `undefined` degradan a `null` — el valor que
 * borra la columna — en vez de lanzar. Mismo tope (`LARGO_MAX_TEXTO`) y mismo
 * formato de mensaje que `exigirTextoAcotado` para lo que sí llega con texto.
 */
export function textoOpcionalAcotado(valor, { etiqueta }) {
  const texto = typeof valor === "string" ? valor.trim() : "";
  if (!texto) return null;
  if (texto.length > LARGO_MAX_TEXTO) {
    throw httpError(400, `${etiqueta} no puede superar los ${LARGO_MAX_TEXTO} caracteres.`);
  }
  return texto;
}

/**
 * Antes de mover una cuenta a `email`, borra la fila que ya lo tiene SOLO si
 * es un registro abandonado: nunca verificada (`verificadaEn` NULL), fuera de
 * su ventana de 24 h y sin pedidos (FK `NoAction` de `Orden`). Esa fila ya es
 * "inexistente" para login y recuperación; sin esto el `update` del email
 * chocaría con el UNIQUE (409) contra una cuenta muerta que la purga todavía
 * no alcanzó. `cliente` es `prisma` o el `tx` de la transacción que escribe.
 */
export async function purgarVencidaConEmail(cliente, email) {
  await cliente.cuentaCliente.deleteMany({
    where: {
      email,
      emailVerificado: false,
      verificadaEn: null,
      createdAt: { lt: new Date(Date.now() - MS_PURGA_NO_VERIFICADAS) },
      ordenes: { none: {} },
    },
  });
}
