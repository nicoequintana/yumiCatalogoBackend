// Validación de las variables de entorno obligatorias, al arrancar.
//
// POR QUÉ EXISTE: hasta ahora nadie chequeaba nada al boot. Las credenciales
// de Cloudinary, por ejemplo, se validan de forma PEREZOSA dentro de
// `cloudinary.service.js` (`configurar()` corre recién en la primera subida),
// así que un deploy mal configurado arrancaba verde, pasaba el health check, y
// recién explotaba cuando el admin intentaba subir la primera foto de un
// producto — a veces días después, con el error apareciendo en un formulario
// en vez de en los logs de arranque.
//
// Este módulo NO tiene efectos al importarse: exporta funciones puras y una
// función de arranque que hay que llamar explícitamente. Es a propósito — los
// 40+ archivos de test importan rutas y controllers sin un entorno completo, y
// una validación que corriera al importar los tumbaría a todos. La validación
// corre únicamente donde tiene sentido: en el entrypoint real (`server.js`),
// antes de levantar el servidor.

// Variables sin las cuales el backend no puede funcionar de verdad:
// - DATABASE_URL: `lib/prisma.js` construye el adapter con ella al importarse.
// - JWT_SECRET: sin esto, `jwt.sign` en el login tira y nadie puede entrar al
//   admin (y un secreto vacío haría falsificable cualquier token).
// - CLOUDINARY_*: storage principal de fotos y video (ver CLAUDE.md).
//
// Las de Google Drive quedan afuera aposta: son legado de solo lectura y solo
// hacen falta mientras existan productos con medios sin migrar, así que un
// deploy nuevo sin ellas es perfectamente válido.
//
// - SMTP_USER / SMTP_PASSWORD: sin credenciales de Gmail no sale ninguna
//   notificación de órdenes. Van acá y no en una validación perezosa por el
//   mismo motivo que Cloudinary: un deploy mal configurado tiene que fallar
//   en los logs de arranque, no días después cuando un cliente no recibe su
//   confirmación y nadie se entera.
// - MAIL_ADMIN_DESTINO: sin esto YIMA no se entera de las órdenes nuevas.
export const VARIABLES_REQUERIDAS = [
  "DATABASE_URL",
  "JWT_SECRET",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "MAIL_ADMIN_DESTINO",
];

/**
 * Devuelve el listado de variables requeridas que faltan o están vacías.
 * Una variable presente pero en blanco cuenta como faltante: en EasyPanel es
 * fácil dejar el campo creado y sin valor, y ese caso rompe igual que si no
 * existiera.
 *
 * @param {Record<string, string | undefined>} [entorno=process.env]
 * @returns {string[]} nombres de las variables faltantes, en orden de declaración
 */
export function variablesFaltantes(entorno = process.env) {
  return VARIABLES_REQUERIDAS.filter((nombre) => {
    const valor = entorno[nombre];
    return valor === undefined || valor === null || String(valor).trim() === "";
  });
}

/**
 * Construye el mensaje de error del arranque. Lista TODAS las que faltan de
 * una vez: si se cortara en la primera, configurar un deploy nuevo sería un
 * ciclo de prueba y error de un reinicio por variable.
 *
 * @param {string[]} faltantes
 * @returns {string}
 */
export function mensajeDeFaltantes(faltantes) {
  const lineas = faltantes.map((nombre) => `  - ${nombre}`);
  return [
    "No se puede arrancar el backend: faltan variables de entorno obligatorias.",
    ...lineas,
    "",
    "Configurálas en el entorno del servicio (ver backend/.env.example) y volvé a desplegar.",
  ].join("\n");
}

/**
 * Valida el entorno y corta el arranque si falta algo.
 *
 * `exit` y `log` se inyectan para poder testear el camino de falla sin matar
 * el proceso de test.
 *
 * @param {object} [opciones]
 * @param {Record<string, string | undefined>} [opciones.entorno=process.env]
 * @param {(codigo: number) => void} [opciones.exit=process.exit]
 * @param {(mensaje: string) => void} [opciones.log=console.error]
 * @returns {string[]} las faltantes encontradas (vacío si está todo bien)
 */
export function validarEntorno({ entorno = process.env, exit = process.exit, log = console.error } = {}) {
  const faltantes = variablesFaltantes(entorno);
  if (faltantes.length > 0) {
    log(mensajeDeFaltantes(faltantes));
    exit(1);
  }
  return faltantes;
}
