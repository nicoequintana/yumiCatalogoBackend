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
//   admin (y un secreto vacío haría falsificable cualquier token). Además de
//   estar presente, tiene que ser FUERTE: con HS256 toda la autenticación del
//   admin depende de su entropía, así que un secreto corto o predecible es
//   crackeable offline (hashcat) y equivale a un admin abierto. Por eso se
//   valida también su longitud mínima (`JWT_SECRET_MIN_BYTES`), no solo su
//   presencia.
// - CLOUDINARY_*: storage principal de fotos y video (ver CLAUDE.md).
// - SMTP_USER / SMTP_PASSWORD: sin credenciales de Gmail no sale ninguna
//   notificación de órdenes. Van acá y no en una validación perezosa por el
//   mismo motivo que Cloudinary: un deploy mal configurado tiene que fallar
//   en los logs de arranque, no días después cuando un cliente no recibe su
//   confirmación y nadie se entera.
// - MAIL_ADMIN_DESTINO: sin esto YIMA no se entera de las órdenes nuevas.
// - FRONTEND_URL: `lib/urlsPublicas.js` cae a `http://localhost:5173` si
//   falta o está vacía, y de ahí salen el `<link rel="canonical">` de cada
//   HTML servido a crawlers, la `url` del `Offer` en el JSON-LD, cada
//   `<loc>` del sitemap y la directiva `Sitemap:` de `robots.txt`. Un deploy
//   con esta variable vacía en EasyPanel publicaría un sitemap entero
//   apuntando a `localhost` sin un solo error en los logs — justo el modo de
//   falla silenciosa que esta validación existe para evitar.
// - BACKEND_PUBLIC_URL: mismo criterio que FRONTEND_URL. `lib/urlsPublicas.js`
//   cae a `http://localhost:4000` si falta, y de ahí sale la URL pública del
//   backend que `seo.controller.js` inyecta en el HTML server-side para
//   crawlers. Sin esta variable, un deploy arrancaría verde con el fallback
//   localhost y emitiría enlaces internos rotos hacia `localhost` sin un solo
//   error en los logs.
//
// Las de Google Drive quedan afuera aposta: son legado de solo lectura y solo
// hacen falta mientras existan productos con medios sin migrar, así que un
// deploy nuevo sin ellas es perfectamente válido.
export const VARIABLES_REQUERIDAS = [
  "DATABASE_URL",
  "JWT_SECRET",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "MAIL_ADMIN_DESTINO",
  "FRONTEND_URL",
  "BACKEND_PUBLIC_URL",
];

// Longitud mínima, en bytes, del JWT_SECRET. Con HS256 la seguridad de toda la
// sesión del admin depende de la entropía del secreto; por debajo de 32 bytes
// es crackeable offline. 32 bytes es el tamaño de bloque de SHA-256, el piso
// razonable para la clave de un HMAC-SHA256.
export const JWT_SECRET_MIN_BYTES = 32;

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
 * Indica si JWT_SECRET está presente pero es demasiado corto para HS256.
 *
 * Un secreto ausente o vacío NO se reporta acá: ya lo cubre
 * `variablesFaltantes` como faltante, y duplicarlo en el mensaje de arranque
 * confundiría el diagnóstico ("falta" y "es débil" a la vez). La cuenta es en
 * BYTES, no en caracteres: un secreto con caracteres multibyte tiene más bytes
 * de entropía que su largo en caracteres, y es la longitud en bytes la que le
 * importa al HMAC.
 *
 * @param {Record<string, string | undefined>} [entorno=process.env]
 * @returns {boolean}
 */
export function jwtSecretDebil(entorno = process.env) {
  const valor = entorno.JWT_SECRET;
  if (valor === undefined || valor === null || String(valor).trim() === "") {
    return false;
  }
  return Buffer.byteLength(String(valor), "utf8") < JWT_SECRET_MIN_BYTES;
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
 * Arma el mensaje de arranque combinando TODOS los problemas detectados —
 * variables faltantes y un JWT_SECRET débil — en un solo texto. Mismo criterio
 * que `mensajeDeFaltantes`: reportar todo junto para no obligar a un ciclo de
 * reinicio por problema.
 *
 * @param {object} problemas
 * @param {string[]} [problemas.faltantes=[]]
 * @param {boolean} [problemas.secretoDebil=false]
 * @returns {string}
 */
export function mensajeDeProblemas({ faltantes = [], secretoDebil = false } = {}) {
  const bloques = [];
  if (faltantes.length > 0) {
    bloques.push(mensajeDeFaltantes(faltantes));
  }
  if (secretoDebil) {
    bloques.push(
      [
        `No se puede arrancar el backend: JWT_SECRET es demasiado corto (necesita al menos ${JWT_SECRET_MIN_BYTES} bytes).`,
        "Con HS256 un secreto corto es crackeable offline y deja el admin abierto.",
        "Generá uno nuevo con `openssl rand -base64 48` y volvé a desplegar.",
      ].join("\n"),
    );
  }
  return bloques.join("\n\n");
}

/**
 * Valida el entorno y corta el arranque si falta algo o si JWT_SECRET es débil.
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
  const secretoDebil = jwtSecretDebil(entorno);
  if (faltantes.length > 0 || secretoDebil) {
    log(mensajeDeProblemas({ faltantes, secretoDebil }));
    exit(1);
  }
  return faltantes;
}
