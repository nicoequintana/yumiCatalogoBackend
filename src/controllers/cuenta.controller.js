import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { logError } from "../lib/logError.js";
import { esEmailValido } from "../lib/emailValido.js";
import { normalizarDni, esDniValido } from "../lib/dni.js";
import {
  HASH_SENUELO,
  compararPassword,
  hashearPassword,
  motivoPasswordRechazada,
  necesitaRehash,
} from "../lib/passwords.js";
import { reservarSlot, estaBajoPresion } from "../lib/colaBcrypt.js";
import { LARGO_MAX_TEXTO } from "../lib/limitesTexto.js";
import {
  ORIGENES_REGISTRO,
  HORAS_PURGA_NO_VERIFICADAS,
  DURACION_DISPOSITIVO_MS,
  COOKIE_DISPOSITIVO,
  MAX_INTENTOS_LOGIN,
  DURACION_BLOQUEO_MS,
  TIPOS_TOKEN,
  normalizarEmail,
} from "../lib/cuentasCliente.js";
import {
  consumirCodigoAcceso,
  consumirToken,
  emitirCodigoAcceso,
  emitirToken,
  hashDeToken,
  invalidarTokensDe,
  revocarTokensPendientes,
} from "../lib/tokensCuenta.js";
import { firmarSesionCliente } from "../lib/jwtCliente.js";
import { purgarVencidaConEmail } from "../lib/cuentaClienteReglas.js";
import { borrarCookieSesion, leerCookie, setCookieDispositivo, setCookieSesion } from "../lib/cookiesCliente.js";
import { randomBytes } from "node:crypto";
import {
  enviarAvisoCambioEmail,
  enviarCambioEmail,
  enviarCodigoAcceso,
  enviarReset,
  enviarVerificacion,
  enviarYaTenesCuenta,
} from "../services/notificacionesCuenta.service.js";

const MENSAJE_REGISTRO = "Te mandamos un mail para confirmar tu cuenta.";
/** Un solo diccionario para todo link de un solo uso (verificar, restablecer y el camino operado). */
export const MENSAJES_TOKEN = {
  INVALIDO: "Ese link no es válido.",
  USADO: "Ese link ya se usó.",
  VENCIDO: "Ese link venció. Pedí uno nuevo.",
};
/** Límite del índice UNIQUE de `CuentaCliente.email` (1700 bytes): más largo revienta el insert como 500. */
const LARGO_MAX_EMAIL = 254;
/**
 * Un token real mide 43 caracteres (32 bytes en base64url). Lo que pase de
 * esto no se hashea: se responde como INVALIDO, sin gastar CPU en SHA-256
 * sobre un body de megas y sin un mensaje distinto que sirva de oráculo.
 */
const LARGO_MAX_TOKEN = 128;
const MS_PURGA_NO_VERIFICADAS = HORAS_PURGA_NO_VERIFICADAS * 60 * 60 * 1000;

/**
 * Una NUNCA verificada cuenta como vencida pasadas las 24 h, aunque la purga
 * todavía no la haya borrado. Con `verificadaEn` puesto la ventana no aplica:
 * la reasignación operada del email apaga `emailVerificado` en un cliente
 * real, con pedidos, que no es un registro abandonado.
 */
function estaFueraDeVentana(cuenta) {
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
async function marcarVerificada(cuentaClienteId, datos = {}) {
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
 * Purga oportunista GLOBAL (spec, paso 5 de "Registro local"): en cada
 * registro se borran TODAS las cuentas no verificadas con más de 24 h, no
 * solo la del email que llegó — no hay cron que lo haga aparte. Nunca lanza:
 * es mantenimiento de fondo y no puede tumbar el registro que lo disparó.
 *
 * Solo las NUNCA verificadas (`verificadaEn` NULL) y sin pedidos: una
 * reasignada por el panel es un cliente real, y una sola fila con órdenes
 * (FK `NoAction` de `Orden`) haría fallar el `deleteMany` ENTERO.
 */
async function purgarNoVerificadasVencidas() {
  try {
    await prisma.cuentaCliente.deleteMany({
      where: {
        emailVerificado: false,
        verificadaEn: null,
        createdAt: { lt: new Date(Date.now() - MS_PURGA_NO_VERIFICADAS) },
        ordenes: { none: {} },
      },
    });
  } catch (err) {
    logError({ mensaje: "No se pudo purgar cuentas no verificadas vencidas", stack: err.stack, causa: err });
  }
}

/**
 * Todo el trabajo de base y el envío de correo, DESPUÉS de responder. Es lo
 * que cierra la enumeración por registro (Amenaza 16): si esto corriera ANTES
 * de `res.json`, el tiempo de respuesta delataría si el email ya existe.
 *
 * El hash va PRIMERO y SIEMPRE, antes de mirar si la cuenta existe, y
 * `liberarSlot` se libera apenas termina — no al final de la función. La
 * cola de `colaBcrypt.js` (capacidad 3, compartida con `/auth/login`) existe
 * para acotar CPU de bcrypt, no para que un Gmail lento o colgado (el envío
 * de abajo puede tardar minutos) le robe slots a los admins tratando de
 * loguearse. Sostener el slot hasta el `await enviarVerificacion` convertiría
 * tres registros concurrentes con SMTP degradado en un 503 para TODO el
 * sistema, login incluido.
 */
async function procesarRegistro({ email, password, nombre, telefono, dni }, liberarSlot) {
  let passwordHash;
  try {
    passwordHash = await hashearPassword(password);
  } finally {
    liberarSlot();
  }

  const existente = await prisma.cuentaCliente.findUnique({ where: { email } });

  if (existente?.emailVerificado) {
    await enviarYaTenesCuenta(existente.email);
  } else if (existente && !estaFueraDeVentana(existente)) {
    // No verificada y todavía dentro de la ventana: reenvía sin pisar nada.
    // `enviarVerificacion` invalida los tokens viejos DESPUÉS de emitir el nuevo.
    await enviarVerificacion(existente);
  } else {
    if (existente) {
      // Vencida: se purga (cascade a sus tokens) y sigue como si "no existiera".
      // `deleteMany` y no `delete`: si la purga global de otra request la
      // borró primero, `delete` lanzaría P2025 y tumbaría este registro. Las
      // guardas van también en el `where` (nunca verificada, sin pedidos): no
      // depender solo del `if` de arriba, que decidió sobre una lectura vieja.
      await prisma.cuentaCliente.deleteMany({ where: { id: existente.id, verificadaEn: null, ordenes: { none: {} } } });
    }
    try {
      const cuenta = await prisma.cuentaCliente.create({
        // Lista blanca campo por campo: un body con `emailVerificado`,
        // `tokenVersion`, `origenRegistro` o `id` NO llega a `data` (Amenaza 8).
        data: { email, passwordHash, origenRegistro: ORIGENES_REGISTRO.LOCAL, nombre, telefono, dni },
      });
      await enviarVerificacion(cuenta);
    } catch (err) {
      // P2002 = alguien más registró el MISMO email entre el `findUnique` de
      // arriba y este `create` (dos pestañas, doble click, un reintento del
      // cliente). Esa otra request ya mandó su propio mail de verificación:
      // esta se descarta en silencio, sin loguear — no es una falla del
      // sistema, es una carrera esperable de una tabla sin lock optimista.
      if (err?.code !== "P2002") throw err;
    }
  }

  await purgarNoVerificadasVencidas();
}

export async function registro(req, res, next) {
  try {
    const emailBruto = req.body?.email;
    const password = req.body?.password;
    const nombre = typeof req.body?.nombre === "string" ? req.body.nombre.trim() : "";
    const telefono = typeof req.body?.telefono === "string" ? req.body.telefono.trim() : "";
    const dni = normalizarDni(req.body?.dni);

    // `typeof === "string"` antes que nada: un email/password que no son
    // string (número, array, objeto) no pueden llegar a bcrypt ni a
    // `normalizarEmail` sin explotar o mentir sobre su forma.
    if (typeof emailBruto !== "string" || emailBruto.length > LARGO_MAX_EMAIL || !esEmailValido(emailBruto)) {
      throw httpError(400, "El email no es válido.");
    }
    if (!nombre) throw httpError(400, "El nombre es obligatorio.");
    if (nombre.length > LARGO_MAX_TEXTO) throw httpError(400, `El nombre no puede superar los ${LARGO_MAX_TEXTO} caracteres.`);
    if (!telefono) throw httpError(400, "El teléfono es obligatorio.");
    if (telefono.length > LARGO_MAX_TEXTO) {
      throw httpError(400, `El teléfono no puede superar los ${LARGO_MAX_TEXTO} caracteres.`);
    }
    if (!esDniValido(dni)) throw httpError(400, "El DNI debe tener 7 u 8 dígitos.");

    const motivo = motivoPasswordRechazada(password, { email: emailBruto, dni });
    if (motivo) throw httpError(400, motivo);

    const email = normalizarEmail(emailBruto);

    // Se reserva ANTES de responder y ANTES de tocar la base (mismo criterio
    // que `/auth/login`, ver `colaBcrypt.js`): si no hay lugar, el cliente
    // recibe 503 CAPACIDAD en vez del 200. Reservarlo más abajo, recién antes
    // de `hashearPassword` en `procesarRegistro`, dejaría ese 503 escapar
    // DESPUÉS de `res.json` — el propio fire-and-forget que la Amenaza 16
    // exige para no filtrar si el email existe terminaría tragándose la
    // saturación en vez de devolvérsela al cliente.
    //
    // La liberación NO queda acá: se la lleva `procesarRegistro`, que la
    // suelta apenas termina de hashear (no al final de todo su trabajo). Ver
    // su docstring. `liberarSlot` ya es idempotente (`colaBcrypt.js`), pero
    // el `.finally` de abajo es una segunda red de seguridad explícita por si
    // algo revienta ANTES de que `procesarRegistro` llegue a liberarlo.
    const liberarSlot = await reservarSlot();

    res.json({ mensaje: MENSAJE_REGISTRO });

    procesarRegistro({ email, password, nombre, telefono, dni }, liberarSlot)
      .catch((err) => {
        logError({ mensaje: `No se pudo procesar el registro de ${email}`, stack: err.stack, causa: err });
      })
      .finally(() => liberarSlot());
  } catch (err) {
    next(err);
  }
}

/**
 * Un navegador que hace click en el link YA probó posesión del buzón: se le
 * ahorra el mail de código de acceso en su primer login (spec, "Verificación").
 *
 * Best-effort: la cuenta ya quedó verificada. Si esto falla, lo único que se
 * pierde es el atajo — el primer login pedirá código —, así que se loguea y
 * la verificación responde igual.
 */
async function marcarDispositivoConocido(res, cuentaClienteId) {
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

const MENSAJE_REENVIO = "Si tenés una cuenta pendiente de confirmar, te mandamos un mail nuevo.";

/**
 * Mismo trato "silencioso" que la rama ya-verificada de `/registro`: ni
 * cuenta inexistente ni ya verificada mandan nada — acá no aplica "olvidé mi
 * contraseña", solo el mail de verificación de una cuenta pendiente.
 *
 * Tampoco la que ya pasó sus 24 h: un reenvío a las 23:59 emitía un token de
 * 24 h más y la cuenta no verificada vivía ~48 h. Esa cuenta se purga; quien
 * la quiera, se registra de nuevo.
 */
async function procesarReenvio(email) {
  const cuenta = await prisma.cuentaCliente.findUnique({ where: { email } });
  if (!cuenta || cuenta.emailVerificado || estaFueraDeVentana(cuenta)) return;
  await enviarVerificacion(cuenta);
}

export async function reenviarVerificacion(req, res, next) {
  try {
    const emailBruto = req.body?.email;

    // Mismo guard que `/registro`, ANTES de responder: un email con forma
    // inválida no arriesga la Amenaza 16 (nunca toca la base ni depende de
    // si esa dirección existe), así que un 400 acá no delata nada.
    if (typeof emailBruto !== "string" || emailBruto.length > LARGO_MAX_EMAIL || !esEmailValido(emailBruto)) {
      throw httpError(400, "El email no es válido.");
    }

    const email = normalizarEmail(emailBruto);

    res.json({ mensaje: MENSAJE_REENVIO });

    procesarReenvio(email).catch((err) => {
      logError({ mensaje: `No se pudo procesar el reenvío de verificación de ${email}`, stack: err.stack, causa: err });
    });
  } catch (err) {
    next(err);
  }
}

function responderMotivo(res, motivo) {
  return res.status(400).json({ error: MENSAJES_TOKEN[motivo], motivo });
}

/**
 * Es POST y no GET a propósito: Outlook Safe Links y varios antivirus
 * prefetchean todo link de un mail — un GET que consumiera el token lo
 * quemaría antes de que la persona lo vea.
 */
export async function verificar(req, res, next) {
  try {
    const tokenClaro = req.body?.token;
    if (typeof tokenClaro !== "string" || !tokenClaro) throw httpError(400, "Falta el token.");
    if (tokenClaro.length > LARGO_MAX_TOKEN) return responderMotivo(res, "INVALIDO");

    const resultado = await consumirToken({ tokenClaro, tipo: "VERIFICACION" });
    if (!resultado.ok) return responderMotivo(res, resultado.motivo);

    // La ventana de 24 h es de la CUENTA, no solo del token: la guarda va en
    // el `where` de la escritura (`marcarVerificada`), no en un `findUnique` +
    // `if`. Una nunca verificada ya fuera de la ventana responde igual que un
    // link vencido y NO se marca verificada.
    const cuentaClienteId = resultado.fila.cuentaClienteId;
    const count = await marcarVerificada(cuentaClienteId);
    if (count === 0) return responderMotivo(res, "VENCIDO");

    await marcarDispositivoConocido(res, cuentaClienteId);

    // Sin token ni cookie de sesión: un link de mail que loguea es una sesión
    // sin contraseña. Entra por login o código, en la Parte 2b.
    res.json({ mensaje: "Tu cuenta está lista. Entrá." });
  } catch (err) {
    next(err);
  }
}

/*
 * Login local (spec "Login local", decisiones 11 y 14). El señuelo, el
 * bloqueo persistido y el código por dispositivo nuevo van juntos: ninguno se
 * puede tocar por separado sin reabrir una amenaza cerrada.
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
    if (typeof emailBruto !== "string" || emailBruto.length > LARGO_MAX_EMAIL || typeof password !== "string") {
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

export { credencialesInvalidas, dispositivoConocido, marcarDispositivoConocido, registrarFallo, resetearFallos };

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

    // `typeof === "string"` y el tope de 254 ANTES de normalizar o tocar la
    // base: mismo guard que `login` y `registro` (índice UNIQUE de
    // `CuentaCliente.email`, ruling de Parte 1).
    if (typeof emailBruto !== "string" || emailBruto.length > LARGO_MAX_EMAIL) throw codigoInvalido();
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
 * sin contraseña para quien controle el buzón, o spam para quien no. La
 * condición va en el `where` de la invalidación (mismo criterio que
 * `stockDescontado`) y el `count` decide. Nunca lanza: la respuesta genérica
 * ya salió antes de llamarla.
 */
async function procesarReenvioCodigo(email) {
  const cuenta = await prisma.cuentaCliente.findUnique({ where: { email } });
  if (!cuenta || !cuenta.emailVerificado) return;

  const { count } = await prisma.tokenCuenta.updateMany({
    where: { cuentaClienteId: cuenta.id, tipo: TIPOS_TOKEN.CODIGO_ACCESO, usadoEn: null, expiraEn: { gt: new Date() } },
    data: { usadoEn: new Date() },
  });
  if (count === 0) return;

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
    const emailValido = typeof emailBruto === "string" && emailBruto.length <= LARGO_MAX_EMAIL;
    const email = emailValido ? normalizarEmail(emailBruto) : "";

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
 * Sesión / perfil (spec "Sesión del cliente" y "Checkout autenticado › El
 * guard"). `req.cuentaCliente` solo trae `{ id, email }` (ver
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
    tieneGoogle: Boolean(cuenta.identidadGoogle),
    tienePassword: Boolean(cuenta.passwordHash),
  };
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
    // guard que el resto del archivo, ninguno de los dos puede llegar a
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

/**
 * Lista blanca: SOLO nombre/telefono/dni pueden llegar a `data` — ni email,
 * password, `emailVerificado`, `origenRegistro` ni `tokenVersion` (Amenaza 8,
 * mismo criterio que `registro`). Mismas reglas de campo que `registro`
 * (obligatorio no vacío, tope `LARGO_MAX_TEXTO`, DNI normalizado y validado).
 */
export async function actualizarPerfil(req, res, next) {
  try {
    const data = {};
    if (req.body?.nombre !== undefined) {
      const nombre = typeof req.body.nombre === "string" ? req.body.nombre.trim() : "";
      if (!nombre) throw httpError(400, "El nombre no puede estar vacío.");
      if (nombre.length > LARGO_MAX_TEXTO) {
        throw httpError(400, `El nombre no puede superar los ${LARGO_MAX_TEXTO} caracteres.`);
      }
      data.nombre = nombre;
    }
    if (req.body?.telefono !== undefined) {
      const telefono = typeof req.body.telefono === "string" ? req.body.telefono.trim() : "";
      if (!telefono) throw httpError(400, "El teléfono no puede estar vacío.");
      if (telefono.length > LARGO_MAX_TEXTO) {
        throw httpError(400, `El teléfono no puede superar los ${LARGO_MAX_TEXTO} caracteres.`);
      }
      data.telefono = telefono;
    }
    if (req.body?.dni !== undefined) {
      const dni = normalizarDni(req.body.dni);
      if (!esDniValido(dni)) throw httpError(400, "El DNI debe tener 7 u 8 dígitos.");
      data.dni = dni;
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

/*
 * Recuperación (spec "Recuperación — `POST /cuenta/olvide` + `POST
 * /cuenta/restablecer`"). Es también la puerta del bloqueo por cuenta
 * (Amenaza 19) y de un registro hecho con un email ajeno (Amenaza 21).
 */

const MENSAJE_OLVIDE = "Si hay una cuenta con ese email, te mandamos las instrucciones.";

/**
 * Corre DESPUÉS de responder y nunca decide la respuesta. Una no verificada
 * fuera de su ventana de 24 h es inexistente (mismo criterio que `login`): un
 * RESET le daría otra hora de vida a una cuenta que la purga ya tendría que
 * haber borrado. Una de Google sin contraseña SÍ recibe el link: el spec dice
 * que así adquiere contraseña.
 *
 * Se emite el nuevo y RECIÉN DESPUÉS se invalidan los anteriores a él (`anterioresA`):
 * invalidar primero deja a la cuenta sin ningún link válido si la emisión
 * falla (mismo orden que `enviarVerificacion`).
 */
async function procesarOlvide(email) {
  const cuenta = await prisma.cuentaCliente.findUnique({ where: { email } });
  if (!cuenta || (!cuenta.emailVerificado && estaFueraDeVentana(cuenta))) return;
  const { tokenClaro, expiraEn, id } = await emitirToken({ cuentaClienteId: cuenta.id, tipo: TIPOS_TOKEN.RESET });
  await invalidarTokensDe(cuenta.id, TIPOS_TOKEN.RESET, { anterioresA: id });
  // `enviarReset` reintenta adentro (hasta ~10 s): por eso nada de esto puede
  // correr antes de `res.json`.
  await enviarReset(cuenta, { tokenClaro, expiraEn });
}

/**
 * SIEMPRE el mismo 200 (Amenaza 16): exista o no la cuenta, esté verificada,
 * sea de Google o una no verificada vencida — y también con un email que no
 * es string o pasa de 254, que ni llega a la base. El tiempo tampoco delata:
 * la consulta y el envío corren después de responder.
 */
export async function olvide(req, res, next) {
  try {
    const emailBruto = req.body?.email;
    const emailAdmisible = typeof emailBruto === "string" && emailBruto.length <= LARGO_MAX_EMAIL;
    const email = emailAdmisible ? normalizarEmail(emailBruto) : "";

    res.json({ mensaje: MENSAJE_OLVIDE });

    if (!email) return;
    procesarOlvide(email).catch((err) => {
      logError({ mensaje: `No se pudo procesar el pedido de reseteo de ${email}`, stack: err.stack, causa: err });
    });
  } catch (err) {
    next(err);
  }
}

/**
 * El orden es lo que evita el estado a medias "link quemado, contraseña sin
 * cambiar":
 *
 * 1. Lectura de solo lectura del token para saber de qué cuenta es. NO decide:
 *    si no está vivo, el motivo lo clasifica `consumirToken` (que con un token
 *    no vivo no escribe nada).
 * 2. Validación de la clave nueva contra el email/DNI de la cuenta y el hash,
 *    ANTES de consumir: una clave rechazada (400) o la cola de bcrypt llena
 *    (503) dejan el link intacto para reintentar.
 * 3. Consumo guardado (`tipo: RESET` en el `where`: un VERIFICACION no sirve),
 *    que es la ÚNICA decisión: si otro request lo consumió entre 1 y 3, este
 *    ve USADO y no escribe.
 * 4. Una sola escritura con la ventana de 24 h en el `where` (una no
 *    verificada vencida no se revive, aunque el reseteo pruebe el buzón).
 *
 * Queda una sola ventana a medias — consumo OK y la escritura falla por un
 * error de la base —; `consumirToken` usa su propio cliente y no entra en una
 * transacción. El usuario pide otro link.
 *
 * El slot de bcrypt cubre SOLO el hash (ruling B); solo un token vivo llega a
 * pagar bcrypt. NO devuelve sesión: un link de mail que loguea es una sesión
 * sin contraseña. Sí setea `dispositivo_cliente`: probó el buzón (spec).
 */
export async function restablecer(req, res, next) {
  try {
    const { token, password } = req.body ?? {};
    if (typeof token !== "string" || !token || typeof password !== "string") throw httpError(400, "Faltan datos.");
    if (token.length > LARGO_MAX_TOKEN) return responderMotivo(res, "INVALIDO");

    const vista = await prisma.tokenCuenta.findUnique({ where: { tokenHash: hashDeToken(token) } });
    const viva = vista && vista.tipo === TIPOS_TOKEN.RESET && !vista.usadoEn && vista.expiraEn > new Date();
    if (!viva) {
      const clasificacion = await consumirToken({ tokenClaro: token, tipo: TIPOS_TOKEN.RESET });
      return responderMotivo(res, clasificacion.ok ? "INVALIDO" : clasificacion.motivo);
    }

    const cuenta = await prisma.cuentaCliente.findUnique({ where: { id: vista.cuentaClienteId } });
    if (!cuenta || (!cuenta.emailVerificado && estaFueraDeVentana(cuenta))) return responderMotivo(res, "INVALIDO");

    const motivo = motivoPasswordRechazada(password, { email: cuenta.email, dni: cuenta.dni });
    if (motivo) throw httpError(400, motivo);

    const liberarSlot = await reservarSlot();
    let passwordHash;
    try {
      passwordHash = await hashearPassword(password);
    } finally {
      liberarSlot();
    }

    const resultado = await consumirToken({ tokenClaro: token, tipo: TIPOS_TOKEN.RESET });
    if (!resultado.ok) return responderMotivo(res, resultado.motivo);

    const cuentaClienteId = resultado.fila.cuentaClienteId;
    // `tokenVersion` +1 cierra TODAS las sesiones; el contador y el bloqueo
    // vuelven a cero en la misma escritura (el reseteo desbloquea, Amenaza 19).
    // `marcarVerificada` pone `emailVerificado` y, si es la primera vez, `verificadaEn`.
    const count = await marcarVerificada(cuentaClienteId, {
      passwordHash,
      tokenVersion: { increment: 1 },
      intentosFallidos: 0,
      bloqueadoHasta: null,
    });
    if (count === 0) return responderMotivo(res, "INVALIDO");
    // Mismo criterio que `cambiarPassword`: un CAMBIO_EMAIL o un código
    // pendiente no sobreviven al reseteo (el RESET usado ya quedó consumido).
    await revocarTokensPendientes(prisma, cuentaClienteId, [TIPOS_TOKEN.CAMBIO_EMAIL, TIPOS_TOKEN.CODIGO_ACCESO]);

    await marcarDispositivoConocido(res, cuentaClienteId);
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
    if (typeof emailBruto !== "string" || emailBruto.length > LARGO_MAX_EMAIL || !esEmailValido(emailBruto)) {
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
