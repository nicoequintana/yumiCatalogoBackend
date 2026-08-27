import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Servicio que habla con el webhook de n8n que genera las imágenes de producto.
 *
 * No toca la red: `fetch` está mockeado en todos los casos. Lo que se afirma
 * acá es la FORMA del request que sale —nombres de campo y ORDEN incluidos—
 * porque son el contrato con el flujo de n8n y romperlos no produce ningún
 * error visible de este lado.
 *
 * Contrato del flujo (ver `docs/contrato-webhook-n8n-imagenes.md`):
 *   202 processing            -> arrancó a generar
 *   200 already_processed     -> la carpeta ya existía, NO generó nada
 *   400 rejected              -> payload inválido, reintentar no sirve
 *   503 verification_failed   -> abortó sin generar nada, ES reintentable
 */
const URL_WEBHOOK = "https://n8n.example.com/webhook/imagenes";

function referenciaFalsa(nombre = "ref.jpg", mimetype = "image/jpeg") {
  return { buffer: Buffer.from("bytes-de-prueba"), originalname: nombre, mimetype };
}

function respuestaJson(cuerpo, status) {
  return new Response(JSON.stringify(cuerpo), { status });
}

describe("n8n.service", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.N8N_WEBHOOK_IMAGENES = URL_WEBHOOK;
    vi.stubGlobal("fetch", vi.fn(async () => respuestaJson({ status: "processing" }, 202)));
  });

  afterEach(() => {
    delete process.env.N8N_WEBHOOK_IMAGENES;
    delete process.env.N8N_WEBHOOK_TOKEN;
    delete process.env.N8N_WEBHOOK_HEADER;
    vi.unstubAllGlobals();
  });

  describe("estaConfigurado", () => {
    it("es false cuando falta la variable", async () => {
      delete process.env.N8N_WEBHOOK_IMAGENES;
      const { estaConfigurado } = await import("./n8n.service.js");
      expect(estaConfigurado()).toBe(false);
    });

    it("es false cuando la variable está vacía", async () => {
      process.env.N8N_WEBHOOK_IMAGENES = "   ";
      const { estaConfigurado } = await import("./n8n.service.js");
      expect(estaConfigurado()).toBe(false);
    });

    it("es true cuando hay URL", async () => {
      const { estaConfigurado } = await import("./n8n.service.js");
      expect(estaConfigurado()).toBe(true);
    });
  });

  describe("cuerpo del request", () => {
    it("postea al webhook con el producto serializado y las referencias", async () => {
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await enviarPedidoDeImagenes({
        producto: { sku: "YIMA-X", nombre: "Termo mate" },
        referencias: [referenciaFalsa("a.jpg"), referenciaFalsa("b.png", "image/png")],
      });

      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, opciones] = fetch.mock.calls[0];
      expect(url).toBe(URL_WEBHOOK);
      expect(opciones.method).toBe("POST");

      const cuerpo = opciones.body;
      expect(JSON.parse(cuerpo.get("producto"))).toEqual({ sku: "YIMA-X", nombre: "Termo mate" });
      expect(cuerpo.get("referencia_1")).toBeInstanceOf(Blob);
      expect(cuerpo.get("referencia_2")).toBeInstanceOf(Blob);
    });

    it("preserva el ORDEN de los append, que es lo que n8n usa para ordenar", async () => {
      // n8n expone los binarios como data0/data1 EN ORDEN DE APARICIÓN EN EL
      // FORM, no por nombre de campo. Invertir el bucle cambia cuál es la
      // referencia principal sin que nada falle.
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await enviarPedidoDeImagenes({
        producto: { sku: "X" },
        referencias: [referenciaFalsa("primera.jpg"), referenciaFalsa("segunda.png", "image/png")],
      });

      expect([...fetch.mock.calls[0][1].body.keys()]).toEqual([
        "producto",
        "referencia_1",
        "referencia_2",
      ]);
    });

    it("descarta las referencias que exceden el máximo", async () => {
      const { enviarPedidoDeImagenes, MAX_REFERENCIAS } = await import("./n8n.service.js");

      await enviarPedidoDeImagenes({
        producto: { sku: "X" },
        referencias: [referenciaFalsa("a.jpg"), referenciaFalsa("b.jpg"), referenciaFalsa("c.jpg")],
      });

      const claves = [...fetch.mock.calls[0][1].body.keys()].filter((k) => k !== "producto");
      expect(claves).toHaveLength(MAX_REFERENCIAS);
    });

    it("NO fija Content-Type a mano (rompería el boundary del multipart)", async () => {
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] });

      const headers = fetch.mock.calls[0][1].headers ?? {};
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-type");
    });
  });

  describe("autenticación", () => {
    it("manda el header de auth con el nombre por defecto", async () => {
      process.env.N8N_WEBHOOK_TOKEN = "secreto-de-prueba";
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] });

      expect(fetch.mock.calls[0][1].headers).toEqual({ "X-API-Key": "secreto-de-prueba" });
    });

    it("respeta un nombre de header configurado", async () => {
      process.env.N8N_WEBHOOK_TOKEN = "secreto-de-prueba";
      process.env.N8N_WEBHOOK_HEADER = "X-Yima-Auth";
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] });

      expect(fetch.mock.calls[0][1].headers).toEqual({ "X-Yima-Auth": "secreto-de-prueba" });
    });

    it("no manda header de auth si no hay token", async () => {
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] });

      expect(fetch.mock.calls[0][1].headers).toEqual({});
    });

    it("un 403 apunta al token, no al flujo, y NO filtra el secreto", async () => {
      process.env.N8N_WEBHOOK_TOKEN = "secreto-de-prueba";
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 403 })));
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      const fallo = await enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] })
        .then(() => null)
        .catch((err) => err);

      expect(fallo.message).toMatch(/N8N_WEBHOOK_TOKEN/);
      expect(fallo.message).not.toContain("secreto-de-prueba");
    });
  });

  describe("respuestas del flujo", () => {
    it("devuelve processing cuando n8n arranca a generar", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respuestaJson({ status: "processing", sku: "X", folder: "productos/X" }, 202)),
      );
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      const salida = await enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] });

      expect(salida).toMatchObject({ estado: "processing", carpeta: "productos/X" });
    });

    it("distingue already_processed, que NO es un error ni un envío normal", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respuestaJson({ status: "already_processed", sku: "X", folder: "productos/X" }, 200)),
      );
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      const salida = await enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] });

      expect(salida.estado).toBe("already_processed");
      expect(salida.carpeta).toBe("productos/X");
    });

    it("un 400 muestra el motivo concreto que vino en el body", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          respuestaJson({ status: "rejected", error: "Missing required product fields: descripcion." }, 400),
        ),
      );
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await expect(
        enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] }),
      ).rejects.toThrow(/Missing required product fields/);
    });

    it("un 503 verification_failed se marca reintentable y dice que no se generó nada", async () => {
      // El caso más confuso del flujo: n8n no pudo verificar contra Cloudinary
      // y ABORTÓ. No es payload inválido (reintentar sirve) ni
      // already_processed (no se sabe si había algo). Tratarlo como error
      // genérico le muestra al admin el mensaje equivocado justo cuando más
      // necesita el correcto.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          respuestaJson(
            { status: "verification_failed", error: "No se pudo verificar el estado de la carpeta destino." },
            503,
          ),
        ),
      );
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      const fallo = await enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] })
        .then(() => null)
        .catch((err) => err);

      expect(fallo.esReintentable).toBe(true);
      expect(fallo.message).toMatch(/no generó nada/i);
      expect(fallo.message).toMatch(/de nuevo/i);
    });

    it("detecta verification_failed también por el body, no solo por el status", async () => {
      // Doble detección a propósito: si algún día el flujo devuelve el body
      // correcto con otro código, el camino reintentable no se pierde.
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => respuestaJson({ status: "verification_failed" }, 500)),
      );
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      const fallo = await enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] })
        .then(() => null)
        .catch((err) => err);

      expect(fallo.esReintentable).toBe(true);
    });

    it("una respuesta que no es JSON no rompe el parseo", async () => {
      // Un proxy caído devuelve HTML. Un JSON.parse pelado lo convertiría en un
      // SyntaxError crudo en vez del error legible que este servicio promete.
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })));
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await expect(
        enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] }),
      ).rejects.toThrow(/HTTP 502/);
    });
  });

  describe("fallos de configuración y de red", () => {
    it("lanza si no está configurado", async () => {
      delete process.env.N8N_WEBHOOK_IMAGENES;
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await expect(
        enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] }),
      ).rejects.toThrow(/no está configurada/i);
    });

    it("traduce un timeout a un mensaje que dice qué revisar", async () => {
      const expiro = new Error("timed out");
      expiro.name = "TimeoutError";
      vi.stubGlobal("fetch", vi.fn(async () => { throw expiro; }));
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await expect(
        enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] }),
      ).rejects.toThrow(/no respondió a tiempo/i);
    });

    it("traduce un fallo de red sin dejar pasar el error crudo", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
      const { enviarPedidoDeImagenes } = await import("./n8n.service.js");

      await expect(
        enviarPedidoDeImagenes({ producto: { sku: "X" }, referencias: [referenciaFalsa()] }),
      ).rejects.toThrow(/No se pudo contactar a n8n/i);
    });
  });
});
