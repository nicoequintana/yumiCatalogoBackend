const BOT_USER_AGENTS = [
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
