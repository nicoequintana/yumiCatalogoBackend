import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { manejadorDeErrores } from "./middlewares/errorHandler.js";

// API-03 — Límite explícito del body de `express.json()`.
//
// `server.js` monta `express.json({ limit: "100kb" })`. Este test NO importa
// `server.js` (arrancaría un listener real y correría la validación de entorno
// al importarse), así que reproduce EXACTAMENTE la misma configuración de
// parser + el manejador de errores real y verifica el contrato: un body que
// supera el límite se rechaza con 413 antes de tocar el handler de la ruta, y
// uno que cabe pasa. Sirve además como prueba ejecutable de la decisión de
// dimensionamiento: una orden con el máximo de 100 items entra con holgura, así
// que el límite no rechaza pedidos legítimos.
function buildApp() {
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.post("/echo", (req, res) => {
    res.json({ recibido: Array.isArray(req.body?.items) ? req.body.items.length : 0 });
  });
  app.use(manejadorDeErrores);
  return app;
}

describe("API-03 — límite del body JSON (100kb)", () => {
  it("server.js declara el límite explícito de 100kb (no el default implícito)", () => {
    // Guarda a nivel de fuente: `server.js` no es importable en un test (arranca
    // un listener y valida el entorno al importarse), así que se verifica que el
    // parser lleve el límite declarado en vez del default silencioso. Muerde si
    // alguien revierte la línea a `express.json()`.
    const serverPath = fileURLToPath(new URL("./server.js", import.meta.url));
    const fuente = readFileSync(serverPath, "utf8");
    expect(fuente).toMatch(/express\.json\(\s*\{[^}]*limit:\s*["']100kb["'][^}]*\}\s*\)/);
  });

  it("rechaza con 413 un body que supera 100kb", async () => {
    // ~150kb de payload: bien por encima del límite.
    const relleno = "x".repeat(150 * 1024);
    const res = await request(buildApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ relleno }));

    expect(res.status).toBe(413);
  });

  it("acepta un body por debajo de 100kb", async () => {
    const relleno = "x".repeat(50 * 1024);
    const res = await request(buildApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ relleno }));

    expect(res.status).toBe(200);
  });

  it("una orden con 100 items entra con holgura por debajo del límite", async () => {
    // Espeja la forma del checkout: cliente + hasta MAX_ITEMS_POR_ORDEN items.
    const orden = {
      cliente: {
        dni: "12.345.678",
        nombre: "Cliente De Prueba Con Nombre Largo",
        telefono: "1122334455",
        email: "cliente.de.prueba@ejemplo.com",
      },
      items: Array.from({ length: 100 }, (_, i) => ({ productId: 100000 + i, cantidad: 999 })),
      notas: "Una nota de pedido de longitud razonable para el caso real.",
    };
    const cuerpo = JSON.stringify(orden);

    // Confirma que el pedido máximo cabe holgadamente en el límite elegido.
    expect(Buffer.byteLength(cuerpo, "utf8")).toBeLessThan(100 * 1024);

    const res = await request(buildApp())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(cuerpo);

    expect(res.status).toBe(200);
    expect(res.body.recibido).toBe(100);
  });
});
