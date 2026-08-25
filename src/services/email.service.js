import nodemailer from "nodemailer";

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

/**
 * @param {{para: string, asunto: string, texto: string, html: string}} mensaje
 * @returns {Promise<void>}
 */
export async function enviarMail({ para, asunto, texto, html }) {
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
 * Descarta el transporter memoizado. Existe solo para los tests, que cambian
 * las variables de entorno entre casos y necesitan que la próxima llamada las
 * vuelva a leer.
 */
export function resetearTransporter() {
  transporter = null;
}
