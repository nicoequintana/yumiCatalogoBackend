import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

const createMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    eventoTrafico: {
      create: (...args) => createMock(...args),
    },
  },
}));

const { default: eventosRouter } = await import("./eventos.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/eventos", eventosRouter);
  app.use(manejadorDeErrores);
  return app;
}

beforeEach(() => {
  createMock.mockReset();
});

describe("POST /api/eventos", () => {
  it("crea un evento válido sin productId ni headers opcionales", async () => {
    createMock.mockResolvedValue({ id: 1 });

    const res = await request(buildApp()).post("/api/eventos").send({ tipo: "CLICK_WHATSAPP" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 1 });
    expect(createMock).toHaveBeenCalledWith({
      data: {
        tipo: "CLICK_WHATSAPP",
        productId: null,
        referrer: null,
        userAgent: null,
      },
    });
  });

  it("crea un evento con productId y captura referrer/userAgent de los headers", async () => {
    createMock.mockResolvedValue({ id: 2 });

    const res = await request(buildApp())
      .post("/api/eventos")
      .set("Referer", "https://yumi.example.com/producto/5")
      .set("User-Agent", "Mozilla/5.0")
      .send({ tipo: "AGREGADO_CARRITO", productId: 5 });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith({
      data: {
        tipo: "AGREGADO_CARRITO",
        productId: 5,
        referrer: "https://yumi.example.com/producto/5",
        userAgent: "Mozilla/5.0",
      },
    });
  });

  it.each(["CLICK_WHATSAPP", "AGREGADO_CARRITO"])(
    "acepta el tipo válido %s (los únicos que emite el frontend)",
    async (tipo) => {
      createMock.mockResolvedValue({ id: 3 });
      const res = await request(buildApp()).post("/api/eventos").send({ tipo });
      expect(res.status).toBe(201);
    },
  );

  it.each(["VISTA_PRODUCTO", "COMPARTIDO", "FAVORITO_AGREGADO", "ORDEN_CREADA"])(
    "rechaza con 400 el tipo %s: solo el backend puede emitirlo (vía logEvento, no por HTTP)",
    async (tipo) => {
      // Estos cuatro tipos alimentan etapas del embudo y contadores que el
      // backend emite por su cuenta. Aceptarlos por el endpoint público dejaba
      // que cualquiera fabricara analytics dentro del rate limit.
      const res = await request(buildApp()).post("/api/eventos").send({ tipo });

      expect(res.status).toBe(400);
      expect(createMock).not.toHaveBeenCalled();
    },
  );

  it("trunca un Referer gigante y responde 201: el evento se guarda, nunca un 500 por P2000", async () => {
    createMock.mockResolvedValue({ id: 6 });

    // `EventoTrafico.referrer` es NVarChar(1000). Un header Referer más largo
    // (trivial de mandar) producía un P2000 de Prisma -> 500 + spam en ErrorLog.
    const refererGigante = `https://spam.example.com/${"a".repeat(3000)}`;

    const res = await request(buildApp())
      .post("/api/eventos")
      .set("Referer", refererGigante)
      .set("User-Agent", "U".repeat(2500))
      .send({ tipo: "CLICK_WHATSAPP", productId: 7 });

    expect(res.status).toBe(201);
    const dataPasada = createMock.mock.calls[0][0].data;
    expect(dataPasada.referrer).toHaveLength(1000);
    expect(dataPasada.referrer).toBe(refererGigante.slice(0, 1000));
    expect(dataPasada.userAgent).toHaveLength(1000);
  });

  it("responde 400 si tipo no es uno de los valores permitidos", async () => {
    const res = await request(buildApp()).post("/api/eventos").send({ tipo: "TIPO_INVENTADO" });

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("responde 400 si falta tipo", async () => {
    const res = await request(buildApp()).post("/api/eventos").send({});

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("responde 400 si productId no es numérico", async () => {
    const res = await request(buildApp())
      .post("/api/eventos")
      .send({ tipo: "VISTA_PRODUCTO", productId: "no-es-numero" });

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("responde 400 si productId es 0", async () => {
    const res = await request(buildApp()).post("/api/eventos").send({ tipo: "VISTA_PRODUCTO", productId: 0 });

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("responde 400 si productId es negativo", async () => {
    const res = await request(buildApp())
      .post("/api/eventos")
      .send({ tipo: "VISTA_PRODUCTO", productId: -1 });

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("responde 400 si productId es un float", async () => {
    const res = await request(buildApp())
      .post("/api/eventos")
      .send({ tipo: "VISTA_PRODUCTO", productId: 1.5 });

    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("nunca escribe un campo de tipo IP en el data pasado a Prisma", async () => {
    createMock.mockResolvedValue({ id: 4 });

    await request(buildApp())
      .post("/api/eventos")
      .set("X-Forwarded-For", "1.2.3.4")
      .send({ tipo: "CLICK_WHATSAPP" });

    const dataPasada = createMock.mock.calls[0][0].data;
    expect(dataPasada).toEqual({
      tipo: "CLICK_WHATSAPP",
      productId: null,
      referrer: null,
      userAgent: null,
    });
    const clavesSospechosas = ["ip", "ipaddress", "remoteaddr", "xforwardedfor"];
    const claves = Object.keys(dataPasada).map((k) => k.toLowerCase());
    expect(claves.some((k) => clavesSospechosas.includes(k))).toBe(false);
  });

  it("no requiere autenticación", async () => {
    createMock.mockResolvedValue({ id: 5 });
    const res = await request(buildApp()).post("/api/eventos").send({ tipo: "CLICK_WHATSAPP" });
    expect(res.status).not.toBe(401);
  });
});

describe("rate limit de POST /api/eventos", () => {
  // El endpoint es público, sin auth, y cada request inserta una fila en
  // `EventoTrafico` — la tabla que más rápido crece del modelo. Sin limitador
  // cualquiera puede inflarla indefinidamente.
  //
  // Lo que se verifica acá es el CABLEADO del limitador en la ruta (headers
  // `RateLimit-*` presentes y con el máximo esperado) y que una ráfaga de
  // navegación normal no se bloquea. El comportamiento del 429 en sí ya está
  // cubierto por `middlewares/rateLimit.middleware.test.js`; repetirlo acá
  // costaría cientos de requests por el límite alto que necesita analytics.
  it("expone los headers RateLimit-* con el máximo elegido para tráfico de analytics", async () => {
    createMock.mockResolvedValue({ id: 1 });

    const res = await request(buildApp()).post("/api/eventos").send({ tipo: "CLICK_WHATSAPP" });

    expect(res.status).toBe(201);
    expect(res.headers["ratelimit-limit"]).toBe("300");
  });

  it("no bloquea una ráfaga de navegación normal (30 eventos seguidos)", async () => {
    createMock.mockResolvedValue({ id: 1 });
    const app = buildApp();

    for (let i = 0; i < 30; i++) {
      const res = await request(app).post("/api/eventos").send({ tipo: "AGREGADO_CARRITO" });
      expect(res.status).toBe(201);
    }
  });
});
