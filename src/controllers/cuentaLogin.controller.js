import { OAuth2Client } from "google-auth-library";
import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { logError } from "../lib/logError.js";
import { HASH_SENUELO, compararPassword, hashearPassword, necesitaRehash } from "../lib/passwords.js";
import { reservarSlot, estaBajoPresion } from "../lib/colaBcrypt.js";
import {
  COOKIE_DISPOSITIVO,
  DURACION_BLOQUEO_MS,
  MAX_INTENTOS_LOGIN,
  ORIGENES_REGISTRO,
  TIPOS_TOKEN,
  esGmail,
  normalizarEmail,
} from "../lib/cuentasCliente.js";
import {
  consumirCodigoAcceso,
  emitirCodigoAcceso,
  hashDeToken,
  revocarTokensPendientes,
} from "../lib/tokensCuenta.js";
import { esEmailAdmisible, estaFueraDeVentana, marcarDispositivoConocido } from "../lib/cuentaClienteReglas.js";
import { firmarSesionCliente } from "../lib/jwtCliente.js";
import { borrarCookieSesion, leerCookie, setCookieSesion } from "../lib/cookiesCliente.js";
import { enviarCodigoAcceso } from "../services/notificacionesCuenta.service.js";

/*
 * Login local (spec "Login local", decisiones 11 y 14), su segundo paso por
 * código y el cierre de sesión. El señuelo, el bloqueo persistido y el código
 * por dispositivo nuevo van juntos: ninguno se puede tocar por separado sin
 * reabrir una amenaza cerrada.
 */

function credencialesInvalidas() {
  return httpError(401, "Email o contraseña incorrectos.");
}

/**
 * Tres escrituras, todas con la condición en el WHERE, nunca en un `if` que
 * leyera el contador: dos fallos concurrentes podrían leer 9 los dos y ninguno
 * bloquear (mismo criterio que `stockDescontado`).
 *
 * 1. Bloqueo VENCIDO: el contador arranca de nuevo en 1 (esa escritura cuenta
 *    este fallo). Sin esto el contador seguía en 10 y un solo error después
 *    del bloqueo re-bloqueaba otra hora. El perdedor de la carrera ve count 0
 *    y pasa al incremento (1 → 2).
 * 2. Incremento.
 * 3. Bloqueo, solo si NO hay uno vigente (`bloqueadoHasta: null`): si no, cada
 *    reintento durante el bloqueo — incluso la víctima con la clave correcta —
 *    lo estiraba otros 60 min.
 */
async function registrarFallo(cuenta) {
  const reinicio = await prisma.cuentaCliente.updateMany({
    where: { id: cuenta.id, bloqueadoHasta: { lt: new Date() } },
    data: { intentosFallidos: 1, bloqueadoHasta: null },
  });
  if (reinicio.count > 0) return;
  await prisma.cuentaCliente.updateMany({ where: { id: cuenta.id }, data: { intentosFallidos: { increment: 1 } } });
  await prisma.cuentaCliente.updateMany({
    where: { id: cuenta.id, intentosFallidos: { gte: MAX_INTENTOS_LOGIN }, bloqueadoHasta: null },
    data: { bloqueadoHasta: new Date(Date.now() + DURACION_BLOQUEO_MS) },
  });
}

/** También lo usa el reseteo de contraseña: "olvidé mi contraseña" desbloquea. */
async function resetearFallos(cuenta) {
  await prisma.cuentaCliente.updateMany({ where: { id: cuenta.id }, data: { intentosFallidos: 0, bloqueadoHasta: null } });
}

/** Cookie `dispositivo_cliente` → hash → fila viva de ESA cuenta (una cookie ajena no sirve). */
async function dispositivoConocido(req, cuenta) {
  const claro = leerCookie(req, COOKIE_DISPOSITIVO);
  if (!claro) return false;
  const fila = await prisma.dispositivoConocido.findFirst({
    where: { tokenHash: hashDeToken(claro), cuentaClienteId: cuenta.id, expiraEn: { gt: new Date() } },
  });
  return Boolean(fila);
}

/**
 * Rehash-al-entrar, DESPUÉS de responder. Se saltea bajo presión de la cola y
 * pide su propio slot: sin eso, bajo saturación una clave correcta pagaría dos
 * bcrypt y una incorrecta uno, y el 503 pasaría a discriminar credenciales
 * válidas. El hash viejo va en el `where`: si entre medio un reseteo cambió la
 * contraseña, este rehash no la pisa con la anterior.
 */
async function rehashearSiHaceFalta(cuenta, password) {
  if (!necesitaRehash(cuenta.passwordHash) || estaBajoPresion()) return;
  const liberar = await reservarSlot();
  let hash;
  try {
    hash = await hashearPassword(password);
  } finally {
    liberar();
  }
  await prisma.cuentaCliente.updateMany({
    where: { id: cuenta.id, passwordHash: cuenta.passwordHash },
    data: { passwordHash: hash },
  });
}

/**
 * El slot de bcrypt cubre SOLO la lectura que decide y el `compare`: se
 * reserva antes de tocar la base (el 503 CAPACIDAD sale primero, ver
 * `colaBcrypt.js`) y se suelta apenas termina bcrypt. El contador de fallos,
 * el reset, el dispositivo y el código corren fuera: una base lenta no puede
 * robarle slots al login del admin, que comparte la cola.
 */
export async function login(req, res, next) {
  let cuentaExitosa = null;
  const password = req.body?.password;
  try {
    const emailBruto = req.body?.email;
    if (!esEmailAdmisible(emailBruto) || typeof password !== "string") {
      throw httpError(400, "Email y contraseña son obligatorios.");
    }
    const email = normalizarEmail(emailBruto);
    if (!email) throw httpError(400, "Email y contraseña son obligatorios.");

    const liberarSlot = await reservarSlot();
    let cuenta;
    let ok;
    try {
      cuenta = await prisma.cuentaCliente.findUnique({ where: { email } });
      // Una no verificada fuera de su ventana de 24 h es INEXISTENTE aunque la
      // purga todavía no la haya borrado: ni cuenta el fallo ni puede entrar.
      if (cuenta && !cuenta.emailVerificado && estaFueraDeVentana(cuenta)) cuenta = null;
      // Se compara SIEMPRE — no existe, no verificada, bloqueada o de Google
      // sin contraseña —: ni el cuerpo ni el tiempo delatan cuál de los casos es.
      ok = await compararPassword(password, cuenta?.passwordHash ?? HASH_SENUELO);
    } finally {
      liberarSlot();
    }

    const bloqueada = Boolean(cuenta?.bloqueadoHasta && cuenta.bloqueadoHasta > new Date());
    if (!cuenta || !cuenta.emailVerificado || bloqueada || !ok) {
      // En segundo plano: esperar las escrituras haría el 401 de una cuenta
      // existente más lento que el de una inexistente (enumeración por tiempo).
      if (cuenta) {
        registrarFallo(cuenta).catch((err) => {
          logError({ mensaje: `No se pudo registrar el fallo de login de la cuenta ${cuenta.id}`, stack: err.stack, causa: err });
        });
      }
      throw credencialesInvalidas();
    }

    await resetearFallos(cuenta);
    cuentaExitosa = cuenta;

    if (await dispositivoConocido(req, cuenta)) {
      setCookieSesion(res, firmarSesionCliente(cuenta));
      res.json({ ok: true });
    } else {
      // Sin cookie de sesión: la clave sola no alcanza en un navegador nuevo.
      const { codigo, expiraEn } = await emitirCodigoAcceso(cuenta.id);
      // `.catch` aunque el sender ya atrape lo suyo: un rechazo sin manejar
      // en el camino del mail ya tumbó el proceso una vez.
      enviarCodigoAcceso(cuenta, { codigo, expiraEn }).catch((err) => {
        logError({ mensaje: `No se pudo enviar el código de acceso a la cuenta ${cuenta.id}`, stack: err.stack, causa: err });
      });
      res.json({ requiereCodigo: true });
    }
  } catch (err) {
    return next(err);
  }

  rehashearSiHaceFalta(cuentaExitosa, password).catch((err) => {
    // Un 503 CAPACIDAD acá es la cola llena: se reintenta en el próximo login.
    if (err?.codigo === "CAPACIDAD") return;
    logError({ mensaje: `No se pudo re-hashear la contraseña de la cuenta ${cuentaExitosa.id}`, stack: err.stack, causa: err });
  });
}

export { credencialesInvalidas, dispositivoConocido, registrarFallo, resetearFallos };

/*
 * Código de acceso (spec "Código de acceso", decisión 14): el segundo paso
 * de `login` cuando el dispositivo no es conocido, y su reenvío.
 */

function codigoInvalido() {
  return httpError(401, "Código incorrecto o vencido.");
}

/**
 * Una cuenta inexistente, no verificada o con código incorrecto/agotado
 * responden EXACTO lo mismo (401, mismo mensaje). El guard de
 * `emailVerificado` es cinturón y tirantes: ni `login` ni `reenviarCodigo`
 * emiten un CODIGO_ACCESO para una cuenta no verificada, así que
 * `consumirCodigoAcceso` ya fallaría sola — pero no depender de esa
 * garantía implícita es el mismo criterio que la ventana de 24 h en
 * `login`.
 */
export async function loginConCodigo(req, res, next) {
  try {
    const emailBruto = req.body?.email;
    const codigo = req.body?.codigo;

    // El tope de 254 y el `typeof` ANTES de normalizar o tocar la base: mismo
    // guard que `login` y `registro` (índice UNIQUE de `CuentaCliente.email`).
    if (!esEmailAdmisible(emailBruto)) throw codigoInvalido();
    const email = normalizarEmail(emailBruto);
    const cuenta = email ? await prisma.cuentaCliente.findUnique({ where: { email } }) : null;
    if (!cuenta || !cuenta.emailVerificado) throw codigoInvalido();

    const { ok } = await consumirCodigoAcceso({ cuentaClienteId: cuenta.id, codigo });
    if (!ok) throw codigoInvalido();

    setCookieSesion(res, firmarSesionCliente(cuenta));
    await marcarDispositivoConocido(res, cuenta.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

const MENSAJE_REENVIO_CODIGO = "Si corresponde, te mandamos un código nuevo.";

/**
 * Re-emite SOLO si ya hay un CODIGO_ACCESO vivo — es decir, si alguien pasó
 * la contraseña en `login` hace menos de 10 min. Sin esa condición, pedir un
 * reenvío para cualquier email verificado mandaba un código nuevo: un login
 * sin contraseña para quien controle el buzón, o spam para quien no.
 *
 * El gate es de SOLO LECTURA (`count`, sin `data`): invalidar el código vivo
 * ANTES de emitir el reemplazo dejaba a la cuenta sin ningún código si la
 * emisión fallaba después. `emitirCodigoAcceso` ya crea el nuevo primero e
 * invalida DESPUÉS solo lo anterior a él (mismo orden que `procesarOlvide` /
 * `enviarVerificacion` / cambio de email) — este gate no debe invalidar nada
 * por su cuenta, o el viejo muere igual antes de que el nuevo exista. Nunca
 * lanza: la respuesta genérica ya salió antes de llamarla.
 */
async function procesarReenvioCodigo(email) {
  const cuenta = await prisma.cuentaCliente.findUnique({ where: { email } });
  if (!cuenta || !cuenta.emailVerificado) return;

  const hayCodigoVivo = await prisma.tokenCuenta.count({
    where: { cuentaClienteId: cuenta.id, tipo: TIPOS_TOKEN.CODIGO_ACCESO, usadoEn: null, expiraEn: { gt: new Date() } },
  });
  if (hayCodigoVivo === 0) return;

  const { codigo, expiraEn } = await emitirCodigoAcceso(cuenta.id);
  await enviarCodigoAcceso(cuenta, { codigo, expiraEn });
}

/**
 * SIEMPRE 200 (Amenaza 16, mismo criterio que `/reenviar-verificacion`): la
 * consulta de la cuenta, la invalidación y el envío corren DESPUÉS de
 * responder, para que el tiempo de respuesta no delate si el email pertenece
 * a una cuenta existente y verificada, ni si tenía un código vivo.
 */
export async function reenviarCodigo(req, res, next) {
  try {
    const emailBruto = req.body?.email;
    const email = esEmailAdmisible(emailBruto) ? normalizarEmail(emailBruto) : "";

    res.json({ mensaje: MENSAJE_REENVIO_CODIGO });

    if (!email) return;
    procesarReenvioCodigo(email).catch((err) => {
      logError({ mensaje: `No se pudo procesar el reenvío de código de ${email}`, stack: err.stack, causa: err });
    });
  } catch (err) {
    next(err);
  }
}

/*
 * Login con Google (spec "Google — POST /api/cuenta/google", decisión 13).
 */

/** Un ID token real ronda 1 KB. Lo que pase de esto no se manda a verificar. */
const LARGO_MAX_CREDENTIAL = 4096;

const MENSAJE_SOLO_GMAIL = "Con una cuenta de Google del trabajo no podemos continuar. Registrate con el formulario.";
const MENSAJE_EMAIL_TOMADO = "Ya hay una cuenta con ese email. Entrá con tu contraseña, o usá «olvidé mi contraseña».";

function googleInvalido() {
  return httpError(401, "No pudimos verificar tu cuenta de Google.");
}

function soloGmail() {
  const err = httpError(403, MENSAJE_SOLO_GMAIL);
  err.codigo = "SOLO_GMAIL";
  return err;
}

/**
 * Un cliente por `clientId`, memoizado a propósito: `OAuth2Client` cachea en
 * la INSTANCIA los certificados públicos de Google. Uno nuevo por request
 * significaba una llamada HTTP a Google en cada login, y un login que se cae
 * cuando ese fetch falla.
 */
let clienteGoogle = null;
let clienteGoogleId = null;
function clienteDeGoogle(clientId) {
  if (clienteGoogle === null || clienteGoogleId !== clientId) {
    clienteGoogle = new OAuth2Client(clientId);
    clienteGoogleId = clientId;
  }
  return clienteGoogle;
}

/**
 * Los cinco casos de la tabla de la spec, en este orden por una razón: el
 * `sub` manda (Gmail no reasigna direcciones, así que no se re-sincroniza el
 * email), y el conflicto con OTRA `IdentidadGoogle` se corta ANTES de
 * cualquier borrado.
 *
 * El "se reemplaza" de la spec vale solo para un registro que NUNCA se
 * verificó. `verificadaEn` es la diferencia entre eso y una cuenta REAL con
 * pedidos: la reasignación de email desde el panel apaga `emailVerificado`
 * sobre un cliente verificado en su día (ver `estaFueraDeVentana` y
 * `adminCuentasCliente.controller.js`), y borrar esa fila acá sería borrarle
 * las órdenes al cliente. Por eso las guardas van en el WHERE del borrado
 * (mismo criterio que `stockDescontado`) y un `count` 0 es 409, no un insert
 * a ciegas que después choca contra el UNIQUE del email.
 */
async function resolverCuentaGoogle({ sub, email, nombre }) {
  const porSub = await prisma.identidadGoogle.findUnique({ where: { sub }, include: { cuenta: true } });
  if (porSub) return porSub.cuenta;

  const porEmail = await prisma.cuentaCliente.findUnique({ where: { email }, include: { identidadGoogle: true } });

  if (porEmail) {
    // Imposible con Gmail (un email ↔ un `sub`); se cubre igual.
    if (porEmail.identidadGoogle) throw httpError(409, "Ese email ya está vinculado a otra cuenta de Google.");

    if (porEmail.emailVerificado) {
      // Las dos credenciales están probadas: se vincula y no se toca nada más.
      await prisma.identidadGoogle.create({ data: { cuentaClienteId: porEmail.id, sub } });
      return porEmail;
    }

    if (porEmail.verificadaEn != null) throw httpError(409, MENSAJE_EMAIL_TOMADO);

    const { count } = await prisma.cuentaCliente.deleteMany({
      where: { id: porEmail.id, emailVerificado: false, verificadaEn: null, ordenes: { none: {} } },
    });
    if (count === 0) throw httpError(409, MENSAJE_EMAIL_TOMADO);
  }

  // `verificadaEn` va en el mismo insert: sin él, la purga de las 24 h vería
  // un registro abandonado. El `sub` también, o el próximo login por `sub` no
  // encontraría nada y entraría por el camino del email.
  return prisma.cuentaCliente.create({
    data: {
      email,
      origenRegistro: ORIGENES_REGISTRO.GOOGLE,
      emailVerificado: true,
      verificadaEn: new Date(),
      passwordHash: null,
      nombre,
      identidadGoogle: { create: { sub } },
    },
  });
}

/**
 * El ID token se verifica SIEMPRE contra Google (`verifyIdToken`), nunca se
 * decodifica a mano: un JWT sin chequear la firma es un formulario que el
 * atacante completa solo.
 *
 * `GOOGLE_CLIENT_ID` está fuera de `VARIABLES_REQUERIDAS` a propósito (spec):
 * sin ella no hay botón y el sitio vende igual. Si alguien llega igual acá,
 * es un 503 explícito, no un 500 con stack.
 *
 * No manda código por mail: Google ya hizo su propia verificación de
 * dispositivo, así que el navegador queda conocido de una.
 */
export async function google(req, res, next) {
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      const err = httpError(503, "El inicio de sesión con Google no está disponible.");
      err.codigo = "GOOGLE_NO_CONFIGURADO";
      throw err;
    }

    const credential = req.body?.credential;
    if (typeof credential !== "string" || credential === "") throw httpError(400, "Falta el credential de Google.");
    if (credential.length > LARGO_MAX_CREDENTIAL) throw googleInvalido();

    let payload;
    try {
      const ticket = await clienteDeGoogle(clientId).verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload();
    } catch {
      // El motivo real (firma, audience, expiración) no se le devuelve al
      // cliente: es un oráculo para quien está probando tokens.
      throw googleInvalido();
    }

    // Ausente es `false`: sin esto se confiaría en un email que Google mismo
    // no da por probado.
    if (payload?.email_verified !== true) throw googleInvalido();

    const email = normalizarEmail(payload.email);
    if (!email) throw googleInvalido();
    // Decisión 13: `hd` es una cuenta de Workspace — la controla el admin de
    // su dominio, que entraría como cualquiera de sus empleados.
    if (payload.hd || !esGmail(email)) throw soloGmail();

    const cuenta = await resolverCuentaGoogle({
      sub: payload.sub,
      email,
      nombre: typeof payload.name === "string" && payload.name !== "" ? payload.name : null,
    });

    setCookieSesion(res, firmarSesionCliente(cuenta));
    await marcarDispositivoConocido(res, cuenta.id);

    res.json({ ok: true, completar: !cuenta.nombre || !cuenta.telefono || !cuenta.dni });
  } catch (err) {
    next(err);
  }
}

/**
 * "Cierra en todos los dispositivos" (spec): revoca por `tokenVersion`, no
 * borra ninguna fila. `dispositivo_cliente` NO se toca — es "navegador
 * conocido", no sesión; una cuenta ya borrada (carrera con otra request) no
 * es un error acá: no hay nada que revocar y la cookie se borra igual.
 */
export async function salir(req, res, next) {
  try {
    await prisma.cuentaCliente.updateMany({
      where: { id: req.cuentaCliente.id },
      data: { tokenVersion: { increment: 1 } },
    });
    // "Todos los dispositivos" incluye lo que está en viaje por mail: un
    // cambio de email o un código pendiente seguirían abriendo la cuenta.
    await revocarTokensPendientes(prisma, req.cuentaCliente.id, [TIPOS_TOKEN.CAMBIO_EMAIL, TIPOS_TOKEN.CODIGO_ACCESO]);
    borrarCookieSesion(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}
