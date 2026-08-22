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

  it("no reconoce un navegador real como bot", () => {
    expect(esBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36")).toBe(false);
  });

  it("devuelve false si no hay user-agent", () => {
    expect(esBot(undefined)).toBe(false);
    expect(esBot("")).toBe(false);
  });
});
