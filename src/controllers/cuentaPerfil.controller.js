import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { logError } from "../lib/logError.js";
import { esEmailValido } from "../lib/emailValido.js";
import { normalizarDni, esDniValido } from "../lib/dni.js";
import { HASH_SENUELO, compararPassword, hashearPassword, motivoPasswordRechazada } from "../lib/passwords.js";
import { reservarSlot } from "../lib/colaBcrypt.js";
import { TIPOS_TOKEN, normalizarEmail } from "../lib/cuentasCliente.js";
import { consumirToken, emitirToken, invalidarTokensDe, revocarTokensPendientes } from "../lib/tokensCuenta.js";
import {
  LARGO_MAX_TOKEN,
  esEmailAdmisible,
  exigirTextoAcotado,
  purgarVencidaConEmail,
  responderMotivo,
  textoOpcionalAcotado,
} from "../lib/cuentaClienteReglas.js";
import { firmarSesionCliente } from "../lib/jwtCliente.js";
import { borrarCookieSesion, setCookieSesion } from "../lib/cookiesCliente.js";
import { enviarAvisoCambioEmail, enviarCambioEmail } from "../services/notificacionesCuenta.service.js";

/*
 * Perfil y credenciales de la cuenta (spec "Sesión del cliente", "Contraseña"
 * y "Cambio de email"). `req.cuentaCliente` solo trae `{ id, email }` (ver
 * `authCliente.middleware.js`): cualquier otro campo del perfil se relee acá.
 */

/** Nunca se seleccionan `tokenVersion`/`intentosFallidos`/`bloqueadoHasta`: ni entran al `select`, así no hay forma de que se cuelen en la respuesta. */
const SELECT_PERFIL = {
  id: true,
  email: true,
  origenRegistro: true,
  nombre: true,
  telefono: true,
  dni: true,
  apodo: true,
  passwordHash: true,
  identidadGoogle: { select: { cuentaClienteId: true } },
};

/** Forma exacta de `GET /api/cuenta` (spec): `tieneGoogle`/`tienePassword` son derivados, nunca el hash ni la fila de Google. */
function mapPerfil(cuenta) {
  return {
    id: cuenta.id,
    email: cuenta.email,
    origenRegistro: cuenta.origenRegistro,
    nombre: cuenta.nombre,
    telefono: cuenta.telefono,
    dni: cuenta.dni,
    apodo: cuenta.apodo,
    tieneGoogle: Boolean(cuenta.identidadGoogle),
    tienePassword: Boolean(cuenta.passwordHash),
  };
}

/** Es lo que lee el guard del checkout y el hook de perfil (spec). Una cuenta borrada entre el middleware y este `findUnique` es 404, nunca un 500. */
export async function obtenerPerfil(req, res, next) {
  try {
    const cuenta = await prisma.cuentaCliente.findUnique({
      where: { id: req.cuentaCliente.id },
      select: SELECT_PERFIL,
    });
    if (!cuenta) throw httpError(404, "Cuenta no encontrada.");
    res.json(mapPerfil(cuenta));
  } catch (err) {
    next(err);
  }
}

/**
 * Lista blanca: SOLO nombre/telefono/dni/apodo pueden llegar a `data` — ni
 * email, password, `emailVerificado`, `origenRegistro` ni `tokenVersion`
 * (Amenaza 8, mismo criterio que `registro`). nombre/telefono/dni son
 * obligatorios no vacíos (mismas reglas que `registro`, tope
 * `LARGO_MAX_TEXTO`, DNI normalizado y validado); `apodo` es el único que
 * pasa por `textoOpcionalAcotado`, así mandar `""` lo BORRA (queda `null`) en
 * vez de tirar 400 — comportamiento querido, no un error.
 */
export async function actualizarPerfil(req, res, next) {
  try {
    const data = {};
    if (req.body?.nombre !== undefined) {
      data.nombre = exigirTextoAcotado(req.body.nombre, { etiqueta: "El nombre", siVacio: "El nombre no puede estar vacío." });
    }
    if (req.body?.telefono !== undefined) {
      data.telefono = exigirTextoAcotado(req.body.telefono, {
        etiqueta: "El teléfono",
        siVacio: "El teléfono no puede estar vacío.",
      });
    }
    if (req.body?.dni !== undefined) {
      const dni = normalizarDni(req.body.dni);
      if (!esDniValido(dni)) throw httpError(400, "El DNI debe tener 7 u 8 dígitos.");
      data.dni = dni;
    }
    if (req.body?.apodo !== undefined) {
      data.apodo = textoOpcionalAcotado(req.body.apodo, { etiqueta: "El apodo" });
    }

    let cuenta;
    try {
      cuenta = await prisma.cuentaCliente.update({
        where: { id: req.cuentaCliente.id },
        data,
        select: SELECT_PERFIL,
      });
    } catch (err) {
      // P2025 = la cuenta ya no existe (carrera con un borrado en otro lado):
      // 404, no el 500 opaco que tiraría `update` sobre una fila inexistente.
      if (err?.code === "P2025") throw httpError(404, "Cuenta no encontrada.");
      throw err;
    }
    res.json(mapPerfil(cuenta));
  } catch (err) {
    next(err);
  }
}

/**
 * Cambio de contraseña autenticado (spec "Contraseña — `PUT /cuenta/password`"):
 * exige la actual y reemite la cookie de sesión con el `tokenVersion` NUEVO
 * — si no, esta MISMA sesión quedaría auto-expulsada por el incremento que
 * ella misma provoca (`tokenVersion` es lo que "cerrar en todos los
 * dispositivos" revoca, ver `salir`).
 *
 * El slot de bcrypt cubre la lectura que decide y los DOS bcrypt (comparar
 * la actual + hashear la nueva) en un mismo slot: mismo criterio que
 * `login`, se reserva antes de la primera consulta a la base
 * (`colaBcrypt.js`) y se libera apenas terminan, ANTES de la escritura.
 *
 * Una cuenta de Google sin contraseña (`passwordHash` null) compara igual
 * contra el señuelo y responde el mismo 401 que una actual equivocada: no
 * hay un mensaje aparte que delate "esta cuenta no tiene contraseña".
 *
 * La escritura lleva el `tokenVersion` leído en el WHERE, no en un `if` que
 * lee y decide (mismo criterio que `stockDescontado`): si cambió entre el
 * `findUnique` y acá — otra sesión cerró la cuenta, otro cambio de clave
 * concurrente —, esta escritura no pisa nada; cuenta 0 y se avisa en vez de
 * reemitir una cookie que ya no coincide con lo que quedó en la base.
 */
export async function cambiarPassword(req, res, next) {
  try {
    const { actual, nueva } = req.body ?? {};
    // `typeof === "string"` ANTES de bcrypt y de reservar el slot: mismo
    // guard que el resto del módulo, ninguno de los dos puede llegar a
    // `compararPassword`/`hashearPassword` sin ser realmente texto.
    if (typeof actual !== "string" || typeof nueva !== "string") {
      throw httpError(400, "Faltan datos.");
    }

    const liberarSlot = await reservarSlot();
    let cuenta;
    let passwordHash;
    try {
      cuenta = await prisma.cuentaCliente.findUnique({ where: { id: req.cuentaCliente.id } });
      if (!cuenta) throw httpError(404, "Cuenta no encontrada.");

      const ok = await compararPassword(actual, cuenta.passwordHash ?? HASH_SENUELO);
      if (!cuenta.passwordHash || !ok) throw httpError(401, "La contraseña actual no es correcta.");

      const motivo = motivoPasswordRechazada(nueva, { email: cuenta.email, dni: cuenta.dni });
      if (motivo) throw httpError(400, motivo);

      passwordHash = await hashearPassword(nueva);
    } finally {
      liberarSlot();
    }

    const { count } = await prisma.cuentaCliente.updateMany({
      where: { id: cuenta.id, tokenVersion: cuenta.tokenVersion },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    });
    if (count === 0) throw httpError(409, "Tu sesión cambió mientras tanto. Volvé a intentar.");
    // Lo pendiente se emitió con la credencial vieja: un CAMBIO_EMAIL pedido
    // por quien secuestró la sesión se podría confirmar después del cambio.
    await revocarTokensPendientes(prisma, cuenta.id, [TIPOS_TOKEN.CAMBIO_EMAIL, TIPOS_TOKEN.CODIGO_ACCESO, TIPOS_TOKEN.RESET]);

    setCookieSesion(res, firmarSesionCliente({ id: cuenta.id, email: cuenta.email, tokenVersion: cuenta.tokenVersion + 1 }));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/*
 * Cambio de email (spec "Cambio de email — `PUT /cuenta/email`"). Dos pasos:
 * el pedido (sesión + contraseña actual) emite un CAMBIO_EMAIL y el link a la
 * dirección NUEVA prueba posesión; recién ahí se aplica.
 */

const AVISO_DESVINCULA_GOOGLE = "Tu cuenta deja de estar vinculada a Google: vas a entrar con tu email y contraseña.";

/**
 * Exige la contraseña actual: una sesión robada no puede llevarse la cuenta a
 * otro buzón. Una cuenta de Google sin contraseña recibe el mismo 401 que una
 * clave equivocada (compara contra el señuelo, igual que `cambiarPassword`);
 * adquiere contraseña con "olvidé mi contraseña". Además, sin contraseña, la
 * desvinculación de Google al confirmar la dejaría sin ninguna credencial.
 *
 * NO consulta si el email nuevo ya es de otra cuenta: responder distinto acá
 * sería un oráculo de enumeración para cualquiera con una sesión. La colisión
 * se resuelve al confirmar (P2002 → 409), cuando el que pregunta ya probó
 * posesión de esa dirección.
 *
 * Slot de bcrypt: la lectura que decide + el `compare` (ruling B, mismo
 * criterio que `cambiarPassword`); la emisión y los mails van fuera.
 */
export async function cambiarEmail(req, res, next) {
  try {
    const emailBruto = req.body?.emailNuevo;
    const password = req.body?.password;
    if (!esEmailAdmisible(emailBruto) || !esEmailValido(emailBruto)) {
      throw httpError(400, "El email nuevo no es válido.");
    }
    if (typeof password !== "string") throw httpError(400, "Falta la contraseña actual.");
    const emailNuevo = normalizarEmail(emailBruto);

    const liberarSlot = await reservarSlot();
    let cuenta;
    try {
      cuenta = await prisma.cuentaCliente.findUnique({
        where: { id: req.cuentaCliente.id },
        include: { identidadGoogle: true },
      });
      if (!cuenta) throw httpError(404, "Cuenta no encontrada.");
      const ok = await compararPassword(password, cuenta.passwordHash ?? HASH_SENUELO);
      if (!cuenta.passwordHash || !ok) throw httpError(401, "La contraseña no es correcta.");
    } finally {
      liberarSlot();
    }

    if (emailNuevo === cuenta.email) throw httpError(400, "Ese ya es tu email.");

    // Se emite y RECIÉN DESPUÉS se invalidan los previos: al revés, una
    // emisión fallida deja a la cuenta sin link vivo (mismo orden que `olvide`).
    const { tokenClaro, id } = await emitirToken({ cuentaClienteId: cuenta.id, tipo: TIPOS_TOKEN.CAMBIO_EMAIL, emailNuevo });
    await invalidarTokensDe(cuenta.id, TIPOS_TOKEN.CAMBIO_EMAIL, { anterioresA: id });

    // `.catch` aunque los senders atrapen lo suyo: un rechazo sin manejar en
    // el camino del mail ya tumbó el proceso una vez.
    enviarCambioEmail(cuenta, { emailNuevo, tokenClaro }).catch((err) => {
      logError({ mensaje: `No se pudo enviar el cambio de email de la cuenta ${cuenta.id}`, stack: err.stack, causa: err });
    });
    enviarAvisoCambioEmail(cuenta, { emailNuevo }).catch((err) => {
      logError({ mensaje: `No se pudo avisar el cambio de email a la cuenta ${cuenta.id}`, stack: err.stack, causa: err });
    });

    const mensaje = "Te mandamos un mail a la nueva dirección para confirmar el cambio.";
    res.json({ mensaje: cuenta.identidadGoogle ? `${mensaje} Al confirmarlo: ${AVISO_DESVINCULA_GOOGLE}` : mensaje });
  } catch (err) {
    next(err);
  }
}

/**
 * Consumo y escritura en UNA transacción (spec): `consumirToken` recibe el
 * cliente `tx`, así el consumo y la clasificación de un token no vivo quedan
 * adentro. Si el `update` del email tira P2002 — otra cuenta tomó esa
 * dirección entre el pedido y el click —, el rollback des-consume el token
 * solo y se responde 409: el link sigue vivo, sin una escritura compensatoria
 * que pudiera fallar y dejarlo quemado. Antes del `update` se purga una fila
 * abandonada que ocupe la dirección (`purgarVencidaConEmail`): no es un 409.
 *
 * `tokenVersion` +1 cierra TODAS las sesiones: la cookie viaja con el email
 * viejo, y la de este navegador se borra en la respuesta (quedaría una cookie
 * muerta que el front leería como sesión). `emailVerificado: true` porque el
 * click probó la dirección nueva.
 *
 * En la MISMA transacción se revocan los RESET y CODIGO_ACCESO pendientes
 * (fueron al buzón VIEJO: tras la mudanza no pueden seguir abriendo la
 * cuenta) y cualquier otro CAMBIO_EMAIL. Con Google vinculado se borra la
 * `IdentidadGoogle`: el login por `sub` y el local apuntarían a emails
 * distintos (spec).
 */
export async function confirmarEmail(req, res, next) {
  try {
    const tokenClaro = req.body?.token;
    if (typeof tokenClaro !== "string" || !tokenClaro) throw httpError(400, "Falta el token.");
    if (tokenClaro.length > LARGO_MAX_TOKEN) return responderMotivo(res, "INVALIDO");

    let resultado;
    try {
      resultado = await prisma.$transaction(async (tx) => {
        const consumo = await consumirToken({ tokenClaro, tipo: TIPOS_TOKEN.CAMBIO_EMAIL }, tx);
        // Token no vivo: el `updateMany` guardado no escribió nada y el motivo
        // ya salió clasificado por el mismo cliente, dentro de la transacción.
        if (!consumo.ok) return { motivo: consumo.motivo };

        const { cuentaClienteId, emailNuevo } = consumo.fila;
        const ahora = new Date();
        const cuenta = await tx.cuentaCliente.findUnique({ where: { id: cuentaClienteId }, include: { identidadGoogle: true } });
        if (!cuenta) throw httpError(404, "Cuenta no encontrada.");

        await purgarVencidaConEmail(tx, emailNuevo);

        // `verificadaEn` solo si faltaba (fila previa a la columna): leído y
        // escrito dentro de la misma transacción, y nunca se pisa.
        await tx.cuentaCliente.update({
          where: { id: cuentaClienteId },
          data: {
            email: emailNuevo,
            emailVerificado: true,
            tokenVersion: { increment: 1 },
            ...(cuenta.verificadaEn ? {} : { verificadaEn: ahora }),
          },
        });
        if (cuenta.identidadGoogle) await tx.identidadGoogle.delete({ where: { cuentaClienteId } });
        await revocarTokensPendientes(tx, cuentaClienteId, [
          TIPOS_TOKEN.RESET,
          TIPOS_TOKEN.CODIGO_ACCESO,
          TIPOS_TOKEN.CAMBIO_EMAIL,
        ]);
        return { googleDesvinculado: Boolean(cuenta.identidadGoogle) };
      });
    } catch (err) {
      if (err?.code === "P2002") throw httpError(409, "Ese email ya está en uso por otra cuenta.");
      throw err;
    }

    if (resultado.motivo) return responderMotivo(res, resultado.motivo);

    borrarCookieSesion(res);
    const mensaje = "Tu email fue actualizado. Volvé a entrar.";
    res.json({ mensaje: resultado.googleDesvinculado ? `${mensaje} ${AVISO_DESVINCULA_GOOGLE}` : mensaje });
  } catch (err) {
    next(err);
  }
}
