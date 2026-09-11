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
const PRESUPUESTO_POR_DEFECTO = { orden: 200, acceso: 60, resto: 100 };
const VAR_ENV_PRESUPUESTO = {
  orden: "PRESUPUESTO_MAIL_ORDEN_HORA",
  acceso: "PRESUPUESTO_MAIL_ACCESO_HORA",
  resto: "PRESUPUESTO_MAIL_RESTO_HORA",
};

function presupuestoDe(categoria) {
  const valor = Number.parseInt(process.env[VAR_ENV_PRESUPUESTO[categoria]] ?? "", 10);
  return Number.isInteger(valor) && valor > 0 ? valor : PRESUPUESTO_POR_DEFECTO[categoria];
}

function estadoInicial() {
  const ahora = Date.now();
  return {
    orden: { contador: 0, ventanaInicio: ahora, avisado: false },
    acceso: { contador: 0, ventanaInicio: ahora, avisado: false, cola: [] },
    resto: { contador: 0, ventanaInicio: ahora, avisado: false },
  };
}

let presupuesto = estadoInicial();

/** Solo para tests: las env de presupuesto y el reloj cambian entre casos. */
export function _reiniciarPresupuestoParaTests() {
  presupuesto = estadoInicial();
}

function refrescarVentana(categoria) {
  const s = presupuesto[categoria];
  if (Date.now() - s.ventanaInicio >= HORA_MS) {
    s.contador = 0;
    s.ventanaInicio = Date.now();
    s.avisado = false;
  }
}

function avisarTope(categoria) {
  const s = presupuesto[categoria];
  if (s.avisado) return;
  s.avisado = true;
  logError({
    mensaje: `Presupuesto de correo agotado: categoría "${categoria}" (${presupuestoDe(categoria)}/hora).`,
  });
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
 * Drena la cola de `acceso` mientras haya lugar. Corre AL PRINCIPIO de cada
 * `enviarMail`, sea cual sea su categoría: es el único gancho sin depender de
 * un timer, y `acceso` es la única categoría que encola (RESET + CODIGO_ACCESO
 * bloquean la entrada, así que perder uno en silencio no es aceptable —
 * Amenaza 10 de la spec).
 */
async function drenarColaAcceso() {
  refrescarVentana("acceso");
  const s = presupuesto.acceso;
  const tope = presupuestoDe("acceso");
  while (s.cola.length > 0 && s.contador < tope) {
    const item = s.cola.shift();
    if (Date.now() - item.encoladoEn > HORA_MS) continue; // vencido: se descarta, no se manda tarde
    s.contador += 1;
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
}

/**
 * Presupuesto por hora, con `acceso` (RESET + CODIGO_ACCESO) y `resto`
 * corriendo en contadores INDEPENDIENTES — Amenaza 10 de la spec (v3 tenía la
 * prioridad invertida): agotar `resto` nunca frena un mail de `acceso`, que es
 * del que depende poder comprar. `orden` y `resto` descartan en silencio al
 * llegar al tope (perder uno es preferible a saturar la cuota); `acceso`
 * encola y drena en el próximo `enviarMail` con lugar, porque perder un mail
 * de acceso en silencio no es aceptable.
 *
 * @param {{para: string, asunto: string, texto: string, html: string, categoria?: "orden"|"acceso"|"resto"}} mensaje
 * @returns {Promise<void>}
 */
export async function enviarMail({ para, asunto, texto, html, categoria = "resto" }) {
  await drenarColaAcceso();
  refrescarVentana(categoria);

  const s = presupuesto[categoria];
  if (s.contador < presupuestoDe(categoria)) {
    s.contador += 1;
    return despacharAhora({ para, asunto, texto, html });
  }

  avisarTope(categoria);
  if (categoria === "acceso") {
    s.cola.push({ para, asunto, texto, html, encoladoEn: Date.now() });
    return;
  }
  // "orden" y "resto" DESCARTAN: perder uno de estos es preferible a que
  // saturen la cuota y le coman el lugar al mail de acceso.
}

/**
 * Descarta el transporter memoizado. Existe solo para los tests, que cambian
 * las variables de entorno entre casos y necesitan que la próxima llamada las
 * vuelva a leer.
 */
export function resetearTransporter() {
  transporter = null;
}
