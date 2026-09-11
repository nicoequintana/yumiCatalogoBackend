import nodemailer from "nodemailer";
import { logError } from "../lib/logError.js";

/**
 * Transporte de correo. ÚNICO módulo del proyecto que conoce SMTP.
 *
 * Gmail con App Password, verificado end-to-end el 23/08/2026. El host y el
 * puerto son constantes y no variables de entorno a propósito: no son
 * configuración del despliegue, son parte de la elección de transporte
 * (ver la spec de esta feature).
 *
 * El `from` tiene que ser la cuenta autenticada — Gmail rechaza cualquier
 * otra dirección —, así que solo el nombre visible es una constante nuestra.
 *
 * Esta función LANZA ante un fallo de envío. Quién decide si eso rompe la
 * operación o se registra y sigue es `notificacionesOrden.service.js`, no
 * este módulo.
 */

const HOST = "smtp.gmail.com";
const PORT = 465;
const NOMBRE_REMITENTE = "YIMA";

let transporter = null;

/**
 * Construcción PEREZOSA, mismo criterio que `cloudinary.service.js`: importar
 * este módulo no puede exigir un entorno completo, porque los tests de rutas
 * y controllers lo arrastran por la cadena de imports sin tener credenciales.
 */
function obtenerTransporter() {
  if (transporter !== null) return transporter;

  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!user || !pass) {
    throw new Error("SMTP_USER y SMTP_PASSWORD deben estar configuradas en el entorno.");
  }

  transporter = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: true,
    auth: { user, pass },
    // Los defaults de nodemailer (2 min / 30 s / 10 min) son más largos que
    // los 15 s que `frontend/src/api/http.js` espera antes de abortar. Sin
    // estos topes, un Gmail lento deja el estado YA guardado (la transacción
    // commitea antes del envío) pero el admin ve un timeout del cliente sobre
    // una pantalla que no refleja lo que pasó — el modo de falla mudo que
    // esta feature existe para eliminar. Calibrados por debajo de esos 15 s
    // para que un envío lento se manifieste como `notificacion.enviada ===
    // false` (con su aviso en pantalla) en vez de como un abort del cliente.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 12_000,
  });

  return transporter;
}

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;

/**
 * Dos ventanas por categoría: por HORA (que una ráfaga no se coma la cuota
 * de golpe) y por DÍA. La diaria existe porque la cuota de Gmail es diaria y
 * compartida: con solo topes horarios, `resto` podía mandar ~2.400 mails en un
 * día sin tocar nunca su tope. Los defaults diarios suman 300 — el "techo
 * declarado" de la spec (sección "Correo": >300 envíos/día → proveedor
 * transaccional) —, con la mayor parte para `orden`, que es plata.
 */
const PRESUPUESTO_POR_DEFECTO = {
  hora: { orden: 200, acceso: 60, resto: 100 },
  dia: { orden: 150, acceso: 90, resto: 60 },
};
const VAR_ENV_PRESUPUESTO = {
  hora: {
    orden: "PRESUPUESTO_MAIL_ORDEN_HORA",
    acceso: "PRESUPUESTO_MAIL_ACCESO_HORA",
    resto: "PRESUPUESTO_MAIL_RESTO_HORA",
  },
  dia: {
    orden: "PRESUPUESTO_MAIL_ORDEN_DIA",
    acceso: "PRESUPUESTO_MAIL_ACCESO_DIA",
    resto: "PRESUPUESTO_MAIL_RESTO_DIA",
  },
};
const DURACION_VENTANA = { hora: HORA_MS, dia: DIA_MS };
const ETIQUETA_VENTANA = { hora: "hora", dia: "día" };

/**
 * Un mail de acceso encolado no sale si al código/token le queda menos que
 * esto: llegaría vencido o a punto de vencer, y la persona pediría otro de
 * todos modos (CODIGO_ACCESO vive 10 min; la cola retiene hasta 1 h).
 */
const MARGEN_VENCIMIENTO_MS = 60 * 1000;

/**
 * Tope de la cola en memoria de `acceso`. Sin él, una avalancha de pedidos de
 * código con el presupuesto agotado crece sin límite en el heap del proceso.
 * Al superarlo se descarta el MÁS VIEJO: es el que antes vence.
 */
const TOPE_COLA_ACCESO = 200;

function presupuestoDe(categoria, ventana) {
  const valor = Number.parseInt(process.env[VAR_ENV_PRESUPUESTO[ventana][categoria]] ?? "", 10);
  return Number.isInteger(valor) && valor > 0 ? valor : PRESUPUESTO_POR_DEFECTO[ventana][categoria];
}

function contadorInicial(ahora) {
  return {
    hora: { contador: 0, inicio: ahora, avisado: false },
    dia: { contador: 0, inicio: ahora, avisado: false },
  };
}

function estadoInicial() {
  const ahora = Date.now();
  return {
    orden: contadorInicial(ahora),
    acceso: { ...contadorInicial(ahora), cola: [], avisoColaLlena: false },
    resto: contadorInicial(ahora),
  };
}

let presupuesto = estadoInicial();
let drenando = false;

/** Solo para tests: las env de presupuesto y el reloj cambian entre casos. */
export function _reiniciarPresupuestoParaTests() {
  presupuesto = estadoInicial();
  drenando = false;
}

function refrescarVentanas(categoria) {
  const ahora = Date.now();
  for (const ventana of ["hora", "dia"]) {
    const v = presupuesto[categoria][ventana];
    if (ahora - v.inicio >= DURACION_VENTANA[ventana]) {
      v.contador = 0;
      v.inicio = ahora;
      v.avisado = false;
    }
  }
}

/** La ventana (hora/día) que está agotada, o `null` si hay lugar en las dos. */
function ventanaAgotada(categoria) {
  refrescarVentanas(categoria);
  for (const ventana of ["hora", "dia"]) {
    if (presupuesto[categoria][ventana].contador >= presupuestoDe(categoria, ventana)) return ventana;
  }
  return null;
}

function consumirCupo(categoria) {
  presupuesto[categoria].hora.contador += 1;
  presupuesto[categoria].dia.contador += 1;
}

/** Una alarma por ventana agotada, no una por cada mail descartado. */
function avisarTope(categoria, ventana) {
  const v = presupuesto[categoria][ventana];
  if (v.avisado) return;
  v.avisado = true;
  logError({
    mensaje: `Presupuesto de correo agotado: categoría "${categoria}" (${presupuestoDe(categoria, ventana)}/${ETIQUETA_VENTANA[ventana]}).`,
  });
}

function estaVencido(item) {
  const ahora = Date.now();
  if (ahora - item.encoladoEn > HORA_MS) return true;
  return item.expiraEn instanceof Date && ahora >= item.expiraEn.getTime() - MARGEN_VENCIMIENTO_MS;
}

function encolarAcceso(item) {
  const s = presupuesto.acceso;
  if (s.cola.length >= TOPE_COLA_ACCESO) {
    s.cola.shift();
    if (!s.avisoColaLlena) {
      s.avisoColaLlena = true;
      logError({
        mensaje: `Cola de mails de acceso llena (${TOPE_COLA_ACCESO}): se descartan los más viejos.`,
      });
    }
  }
  s.cola.push(item);
}

async function despacharAhora({ para, asunto, texto, html }) {
  const cliente = obtenerTransporter();
  await cliente.sendMail({
    from: `${NOMBRE_REMITENTE} <${process.env.SMTP_USER}>`,
    to: para,
    subject: asunto,
    text: texto,
    html,
  });
}

/**
 * Drena la cola de `acceso` mientras haya lugar. Lo dispara cada `enviarMail`,
 * sea cual sea su categoría: es el único gancho sin depender de un timer, y
 * `acceso` es la única categoría que encola (RESET + CODIGO_ACCESO bloquean la
 * entrada, así que perder uno en silencio no es aceptable — Amenaza 10 de la
 * spec). Los envíos van en serie y en orden de llegada.
 */
async function drenarColaAcceso() {
  const s = presupuesto.acceso;
  try {
    while (s.cola.length > 0 && ventanaAgotada("acceso") === null) {
      const item = s.cola.shift();
      if (estaVencido(item)) continue; // se descarta: no se manda tarde
      consumirCupo("acceso");
      try {
        await despacharAhora(item);
      } catch (err) {
        logError({
          mensaje: `No se pudo drenar un mail de acceso encolado para ${item.para}`,
          stack: err.stack,
          causa: err,
        });
      }
    }
    if (s.cola.length === 0) s.avisoColaLlena = false;
  } finally {
    // Acá y no en un `.finally()` encadenado afuera: cuando el loop termina
    // sin haber esperado nada, esto corre en el MISMO tick y el próximo
    // `enviarMail` ya puede arrancar otro drenado; un `.finally()` externo lo
    // liberaría varias microtareas después y ese envío saltearía el drenado.
    drenando = false;
  }
}

/**
 * Arranca el drenado SIN esperarlo, y nunca dos a la vez. Esperarlo hacía que
 * el mail en curso —p. ej. el aviso de cambio de estado, que el admin espera
 * dentro de `PATCH /ordenes/:id/estado`— quedara detrás de TODA la cola de
 * acceso, un envío SMTP por vez. El flag evita que dos drenados concurrentes
 * saquen items en paralelo y los manden fuera de orden.
 */
function dispararDrenado() {
  if (drenando || presupuesto.acceso.cola.length === 0) return;
  drenando = true;
  drenarColaAcceso().catch((err) =>
    logError({ mensaje: "Falló el drenado de la cola de acceso", stack: err.stack, causa: err }),
  );
}

/**
 * Presupuesto por hora y por día, con `acceso` (RESET + CODIGO_ACCESO) y
 * `resto` corriendo en contadores INDEPENDIENTES — Amenaza 10 de la spec (v3
 * tenía la prioridad invertida): agotar `resto` nunca frena un mail de
 * `acceso`, que es del que depende poder comprar. `orden` y `resto` descartan
 * al llegar a cualquiera de los dos topes (perder uno es preferible a saturar
 * la cuota); `acceso` encola y drena después, porque perder un mail de acceso
 * en silencio no es aceptable. Una categoría desconocida cuenta como `resto`.
 *
 * Sigue LANZANDO ante un fallo de transporte. Un descarte por presupuesto NO
 * lanza —no es una falla— pero se informa en el resultado, para que quien
 * reporta "se mandó" (`notificacionesOrden`) no mienta.
 *
 * `expiraEn` (opcional): vencimiento del código/token que lleva el mail. Si
 * el mail termina en la cola, se descarta en vez de salir cuando al código le
 * quedan menos de `MARGEN_VENCIMIENTO_MS`.
 *
 * @param {{para: string, asunto: string, texto: string, html: string, categoria?: "orden"|"acceso"|"resto", expiraEn?: Date}} mensaje
 * @returns {Promise<{descartado: boolean, encolado?: true}>}
 */
export async function enviarMail({ para, asunto, texto, html, categoria = "resto", expiraEn }) {
  dispararDrenado();

  const clave = Object.hasOwn(presupuesto, categoria) ? categoria : "resto";
  const agotada = ventanaAgotada(clave);
  if (agotada === null) {
    consumirCupo(clave);
    await despacharAhora({ para, asunto, texto, html });
    return { descartado: false };
  }

  avisarTope(clave, agotada);
  if (clave === "acceso") {
    encolarAcceso({ para, asunto, texto, html, expiraEn, encoladoEn: Date.now() });
    return { descartado: false, encolado: true };
  }
  // "orden" y "resto" DESCARTAN: perder uno de estos es preferible a que
  // saturen la cuota y le coman el lugar al mail de acceso.
  return { descartado: true };
}

/**
 * Descarta el transporter memoizado. Existe solo para los tests, que cambian
 * las variables de entorno entre casos y necesitan que la próxima llamada las
 * vuelva a leer.
 */
export function resetearTransporter() {
  transporter = null;
}
