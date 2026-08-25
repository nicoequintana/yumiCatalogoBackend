/**
 * User-Agents que reciben HTML server-side en vez de la SPA.
 *
 * UNA SOLA LISTA a propósito, no una por tipo de bot. La lista está DUPLICADA
 * A MANO en `frontend/nginx.conf` (el `map $http_user_agent $es_bot_og`), que
 * es lo que efectivamente desvía el tráfico — este módulo solo decide qué
 * responder una vez que la request llegó. Partirla en "sociales" e
 * "indexadores" duplicaría esa sincronización manual, que es exactamente el
 * tipo de cosa que se desincroniza sin avisar. WhatsApp recibe unos KB de más
 * que ignora; el costo real de dos listas es más alto que eso.
 *
 * AL TOCAR ESTA LISTA, TOCAR TAMBIÉN `frontend/nginx.conf`.
 */
const BOT_USER_AGENTS = [
  // Redes sociales — arman el preview de un link compartido.
  "facebookexternalhit",
  "facebot",
  "twitterbot",
  "whatsapp",
  "linkedinbot",
  "slackbot",
  "telegrambot",
  "discordbot",
  "pinterest",
  "redditbot",
  "skypeuripreview",
  // Buscadores. `googlebot` matchea también Googlebot-Image y Googlebot-News,
  // que es lo correcto: todos deben recibir el HTML server-side.
  "googlebot",
  "bingbot",
  "duckduckbot",
  "applebot",
  "yandexbot",
  // Crawlers de sistemas de IA. Hoy son una fuente real de descubrimiento y
  // cuestan una línea cada uno.
  "gptbot",
  "claudebot",
  "perplexitybot",
  "oai-searchbot",
];

/**
 * @param {string | undefined} userAgent
 * @returns {boolean}
 */
export function esBot(userAgent) {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return BOT_USER_AGENTS.some((bot) => ua.includes(bot));
}
