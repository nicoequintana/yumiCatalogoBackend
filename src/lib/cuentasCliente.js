/**
 * Constantes cerradas de las cuentas de cliente.
 *
 * SQL Server vía Prisma no soporta enums: las listas viven acá y son la única
 * copia ejecutable, mismo criterio que `estadosOrden.js` y `campanias.js`.
 */

const MINUTO = 60 * 1000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

export const ORIGENES_REGISTRO = Object.freeze({ LOCAL: "LOCAL", GOOGLE: "GOOGLE" });

export const TIPOS_TOKEN = Object.freeze({
  VERIFICACION: "VERIFICACION",
  RESET: "RESET",
  CAMBIO_EMAIL: "CAMBIO_EMAIL",
  CODIGO_ACCESO: "CODIGO_ACCESO",
});

/**
 * RESET dura una hora y no 24 a propósito: una ventana de reseteo abierta es
 * una llave esperando en un buzón. VERIFICACION viaja en cada mail de pedido
 * y puede leerse al día siguiente.
 */
export const DURACION_TOKEN_MS = Object.freeze({
  VERIFICACION: 24 * HORA,
  RESET: 1 * HORA,
  CAMBIO_EMAIL: 24 * HORA,
  CODIGO_ACCESO: 10 * MINUTO,
});

export const MAX_INTENTOS_LOGIN = 10;
export const DURACION_BLOQUEO_MS = 60 * MINUTO;
/** Con seis dígitos la entropía no defiende; este contador sí. */
export const MAX_INTENTOS_CODIGO = 5;
export const DURACION_DISPOSITIVO_MS = 90 * DIA;
export const DURACION_SESION = "7d";
export const DURACION_SESION_MS = 7 * DIA;
export const HORAS_PURGA_NO_VERIFICADAS = 24;

export const COOKIE_SESION = "sesion_cliente";
export const COOKIE_DISPOSITIVO = "dispositivo_cliente";

const DOMINIOS_GMAIL = new Set(["gmail.com", "googlemail.com"]);

export function normalizarEmail(email) {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

/**
 * Decisión 13 de la spec: Google entra solo con cuentas personales. Una cuenta
 * de Workspace la controla el admin de su dominio; una de Gmail, solo su dueño,
 * y Google nunca reasigna una dirección de Gmail.
 */
export function esGmail(email) {
  const normalizado = normalizarEmail(email);
  const arroba = normalizado.lastIndexOf("@");
  if (arroba < 1) return false;
  return DOMINIOS_GMAIL.has(normalizado.slice(arroba + 1));
}
