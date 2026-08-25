import { describe, expect, it } from "vitest";
import { esBot } from "./botDetector.js";

describe("esBot", () => {
  it("reconoce el user-agent de Facebook/WhatsApp", () => {
    expect(esBot("facebookexternalhit/1.1")).toBe(true);
    expect(esBot("WhatsApp/2.23.20.0")).toBe(true);
  });

  it("reconoce Twitterbot", () => {
    expect(esBot("Twitterbot/1.0")).toBe(true);
  });

  it("reconoce LinkedInBot, Slackbot, TelegramBot, Discordbot, Pinterest, redditbot, SkypeUriPreview", () => {
    expect(esBot("LinkedInBot/1.0")).toBe(true);
    expect(esBot("Slackbot-LinkExpanding 1.0")).toBe(true);
    expect(esBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(esBot("Mozilla/5.0 (compatible; Discordbot/2.0;+https://discordapp.com)")).toBe(true);
    expect(esBot("Pinterest/0.2")).toBe(true);
    expect(esBot("Mozilla/5.0 (compatible; redditbot/1.0;)")).toBe(true);
    expect(esBot("SkypeUriPreview Preview/0.5")).toBe(true);
  });

  it("es case-insensitive", () => {
    expect(esBot("FACEBOOKEXTERNALHIT/1.1")).toBe(true);
  });

  it("reconoce Googlebot y sus variantes", () => {
    expect(esBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)")).toBe(true);
    expect(esBot("Googlebot-Image/1.0")).toBe(true);
  });

  it("reconoce Google-InspectionTool (Prueba de Resultados Enriquecidos)", () => {
    expect(esBot("Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)")).toBe(true);
  });

  it("reconoce el resto de los buscadores", () => {
    expect(esBot("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)")).toBe(true);
    expect(esBot("DuckDuckBot/1.1; (+http://duckduckgo.com/duckduckbot.html)")).toBe(true);
    expect(esBot("Mozilla/5.0 (Macintosh) AppleWebKit/605 (KHTML, like Gecko) Applebot/0.1")).toBe(true);
    expect(esBot("Mozilla/5.0 (compatible; YandexBot/3.0)")).toBe(true);
  });

  it("reconoce los crawlers de sistemas de IA", () => {
    expect(esBot("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)")).toBe(true);
    expect(esBot("Mozilla/5.0 (compatible; ClaudeBot/1.0)")).toBe(true);
    expect(esBot("Mozilla/5.0 (compatible; PerplexityBot/1.0)")).toBe(true);
    expect(esBot("Mozilla/5.0 (compatible; OAI-SearchBot/1.0)")).toBe(true);
  });

  it("no reconoce un navegador real como bot", () => {
    expect(esBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")).toBe(false);
  });

  it("devuelve false si no hay user-agent", () => {
    expect(esBot(undefined)).toBe(false);
    expect(esBot("")).toBe(false);
  });
});
