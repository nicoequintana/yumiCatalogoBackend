import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";

process.env.COOKIE_DOMINIO = "";
const {
  borrarCookieSesion,
  leerCookie,
  parsearCookies,
  setCookieDispositivo,
  setCookieSesion,
} = await import("./cookiesCliente.js");

describe("parsearCookies", () => {
  it("parsea pares separados por ; con espacios y valores con =", () => {
    expect(parsearCookies("a=1; b=x=y ;c=")).toEqual({ a: "1", b: "x=y", c: "" });
  });

  it("decodifica URI y tolera basura", () => {
    expect(parsearCookies("s=a%20b; sinigual; =sinNombre")).toEqual({ s: "a b" });
    expect(parsearCookies(undefined)).toEqual({});
    expect(parsearCookies("")).toEqual({});
  });

  it("ante un valor mal codificado no lanza: lo deja crudo", () => {
    expect(parsearCookies("s=%E0%A4%A")).toEqual({ s: "%E0%A4%A" });
  });
});

describe("leerCookie", () => {
  it("lee del header cookie del request", () => {
    expect(leerCookie({ headers: { cookie: "sesion_cliente=abc; otra=1" } }, "sesion_cliente")).toBe("abc");
    expect(leerCookie({ headers: {} }, "sesion_cliente")).toBeNull();
  });
});

describe("setters", () => {
  function appCon(handler) {
    const app = express();
    app.get("/x", (req, res) => {
      handler(res);
      res.json({});
    });
    return app;
  }

  afterEach(() => {
    process.env.COOKIE_DOMINIO = "";
  });

  it("setCookieSesion: HttpOnly, Secure, SameSite=Strict, Path=/, 7 dias, sin Domain en desarrollo", async () => {
    const res = await request(appCon((r) => setCookieSesion(r, "jwt-x"))).get("/x");
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("sesion_cliente="));
    expect(cookie).toMatch(/^sesion_cliente=jwt-x;/);
    expect(cookie).toMatch(/Max-Age=604800/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toMatch(/Domain=/);
  });

  it("con COOKIE_DOMINIO la cookie lleva Domain", async () => {
    process.env.COOKIE_DOMINIO = ".yima-productos.com";
    const res = await request(appCon((r) => setCookieSesion(r, "jwt-x"))).get("/x");
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("sesion_cliente="));
    expect(cookie).toMatch(/Domain=\.yima-productos\.com/);
  });

  it("borrarCookieSesion emite la cookie vacia con Max-Age=0 y los MISMOS atributos, o el navegador no la borra", async () => {
    process.env.COOKIE_DOMINIO = ".yima-productos.com";
    const res = await request(appCon((r) => borrarCookieSesion(r))).get("/x");
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("sesion_cliente="));
    expect(cookie).toMatch(/^sesion_cliente=;/);
    expect(cookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
    expect(cookie).toMatch(/Domain=\.yima-productos\.com/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it("setCookieDispositivo dura 90 dias", async () => {
    const res = await request(appCon((r) => setCookieDispositivo(r, "disp-x"))).get("/x");
    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("dispositivo_cliente="));
    expect(cookie).toMatch(/Max-Age=7776000/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });
});
