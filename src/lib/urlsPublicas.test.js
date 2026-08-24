import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { urlFrontend, urlBackend } from "./urlsPublicas.js";

const ENV_ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.FRONTEND_URL;
  delete process.env.BACKEND_PUBLIC_URL;
});

afterEach(() => {
  process.env = { ...ENV_ORIGINAL };
});

describe("urlFrontend", () => {
  it("sin la variable seteada, cae al default", () => {
    expect(urlFrontend()).toBe("http://localhost:5173");
  });

  it("con una URL normal, la devuelve tal cual", () => {
    process.env.FRONTEND_URL = "https://yima-productos.com";
    expect(urlFrontend()).toBe("https://yima-productos.com");
  });

  it("con una barra final, la saca", () => {
    process.env.FRONTEND_URL = "https://yima-productos.com/";
    expect(urlFrontend()).toBe("https://yima-productos.com");
  });

  it("con varias barras finales, las saca todas", () => {
    process.env.FRONTEND_URL = "https://yima-productos.com///";
    expect(urlFrontend()).toBe("https://yima-productos.com");
  });

  it("con la variable como string vacío, cae al default", () => {
    process.env.FRONTEND_URL = "";
    expect(urlFrontend()).toBe("http://localhost:5173");
  });
});

describe("urlBackend", () => {
  it("sin la variable seteada, cae al default", () => {
    expect(urlBackend()).toBe("http://localhost:4000");
  });

  it("con una URL normal, la devuelve tal cual", () => {
    process.env.BACKEND_PUBLIC_URL = "https://api.yima-productos.com";
    expect(urlBackend()).toBe("https://api.yima-productos.com");
  });

  it("con una barra final, la saca", () => {
    process.env.BACKEND_PUBLIC_URL = "https://api.yima-productos.com/";
    expect(urlBackend()).toBe("https://api.yima-productos.com");
  });

  it("con varias barras finales, las saca todas", () => {
    process.env.BACKEND_PUBLIC_URL = "https://api.yima-productos.com///";
    expect(urlBackend()).toBe("https://api.yima-productos.com");
  });

  it("con la variable como string vacío, cae al default", () => {
    process.env.BACKEND_PUBLIC_URL = "";
    expect(urlBackend()).toBe("http://localhost:4000");
  });
});
