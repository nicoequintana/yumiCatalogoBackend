import { beforeEach, describe, expect, it, vi } from "vitest";

const campaniaFindUniqueMock = vi.fn();
const promocionFindUniqueMock = vi.fn();
const eventoCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    campania: { findUnique: (...a) => campaniaFindUniqueMock(...a) },
    promocion: { findUnique: (...a) => promocionFindUniqueMock(...a) },
    eventoTrafico: { create: (...a) => eventoCreateMock(...a) },
  },
}));

const { crearDeCampania, crearDePromocion } = await import("./eventosComerciales.controller.js");

function buildReqRes({ params = {}, body = {}, headers = {} } = {}) {
  const req = {
    params,
    body,
    get: (nombre) => headers[nombre.toLowerCase()] ?? undefined,
  };
  const res = {
    statusCode: 200,
    body: null,
    status(codigo) {
      this.statusCode = codigo;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

beforeEach(() => {
  campaniaFindUniqueMock.mockReset();
  promocionFindUniqueMock.mockReset();
  eventoCreateMock.mockReset();
});

describe("crearDeCampania", () => {
  it("escribe una impresión con campaniaId y promocionId null EXPLÍCITO, sin productId ni IP", async () => {
    campaniaFindUniqueMock.mockResolvedValue({ id: 12 });
    eventoCreateMock.mockResolvedValue({ id: 900 });
    const { req, res, next } = buildReqRes({
      params: { id: "12" },
      body: { tipo: "IMPRESION_COMERCIAL", origen: "BANNER" },
      headers: { referer: "https://yima-productos.com/", "user-agent": "Mozilla/5.0" },
    });

    await crearDeCampania(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ id: 900 });
    expect(eventoCreateMock).toHaveBeenCalledWith({
      data: {
        tipo: "IMPRESION_COMERCIAL",
        origen: "BANNER",
        destino: null,
        campaniaId: 12,
        promocionId: null,
        productId: null,
        referrer: "https://yima-productos.com/",
        userAgent: "Mozilla/5.0",
      },
    });
    // El guard de "nunca IP": el data no tiene ninguna clave que la lleve.
    const data = eventoCreateMock.mock.calls[0][0].data;
    expect(Object.keys(data)).not.toContain("ip");
  });

  it("un click guarda su destino", async () => {
    campaniaFindUniqueMock.mockResolvedValue({ id: 12 });
    eventoCreateMock.mockResolvedValue({ id: 901 });
    const { req, res, next } = buildReqRes({
      params: { id: "12" },
      body: { tipo: "CLICK_COMERCIAL", origen: "MODAL", destino: "PRODUCTO" },
    });

    await crearDeCampania(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(eventoCreateMock.mock.calls[0][0].data).toMatchObject({
      tipo: "CLICK_COMERCIAL",
      origen: "MODAL",
      destino: "PRODUCTO",
      campaniaId: 12,
      promocionId: null,
    });
  });

  it("verifica la existencia por PK con select mínimo", async () => {
    campaniaFindUniqueMock.mockResolvedValue({ id: 12 });
    eventoCreateMock.mockResolvedValue({ id: 902 });
    const { req, res, next } = buildReqRes({
      params: { id: "12" },
      body: { tipo: "IMPRESION_COMERCIAL", origen: "MODAL" },
    });

    await crearDeCampania(req, res, next);

    expect(campaniaFindUniqueMock).toHaveBeenCalledWith({
      where: { id: 12 },
      select: { id: true },
    });
  });

  it("una campaña inexistente es 404 y NO escribe", async () => {
    campaniaFindUniqueMock.mockResolvedValue(null);
    const { req, res, next } = buildReqRes({
      params: { id: "999" },
      body: { tipo: "IMPRESION_COMERCIAL", origen: "MODAL" },
    });

    await crearDeCampania(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(eventoCreateMock).not.toHaveBeenCalled();
  });

  // La vigencia NO se valida acá a propósito (spec §5): la lectura acota al
  // período de la campaña, así que un evento fuera de él no aparece. Este
  // test fija esa decisión para que nadie sume "por prolijidad" una consulta
  // cara a cada impresión.
  it("una campaña FINALIZADA se acepta igual: la vigencia la decide la lectura", async () => {
    campaniaFindUniqueMock.mockResolvedValue({ id: 5 });
    eventoCreateMock.mockResolvedValue({ id: 903 });
    const { req, res, next } = buildReqRes({
      params: { id: "5" },
      body: { tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "CAMPANIA" },
    });

    await crearDeCampania(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    // No se pidió nada más que la existencia.
    expect(campaniaFindUniqueMock).toHaveBeenCalledTimes(1);
    expect(campaniaFindUniqueMock.mock.calls[0][0].select).toEqual({ id: true });
  });

  it.each(["abc", "0", "-3", "1.5"])("un id %s es 400 antes de tocar la base", async (id) => {
    const { req, res, next } = buildReqRes({
      params: { id },
      body: { tipo: "IMPRESION_COMERCIAL", origen: "MODAL" },
    });

    await crearDeCampania(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(campaniaFindUniqueMock).not.toHaveBeenCalled();
  });

  it("un cuerpo inválido es 400 antes de tocar la base", async () => {
    const { req, res, next } = buildReqRes({
      params: { id: "12" },
      body: { tipo: "VISTA_PRODUCTO", origen: "MODAL" },
    });

    await crearDeCampania(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 400 }));
    expect(campaniaFindUniqueMock).not.toHaveBeenCalled();
  });

  it("referrer y userAgent ausentes se guardan como null", async () => {
    campaniaFindUniqueMock.mockResolvedValue({ id: 12 });
    eventoCreateMock.mockResolvedValue({ id: 904 });
    const { req, res, next } = buildReqRes({
      params: { id: "12" },
      body: { tipo: "IMPRESION_COMERCIAL", origen: "MODAL" },
    });

    await crearDeCampania(req, res, next);

    expect(eventoCreateMock.mock.calls[0][0].data).toMatchObject({
      referrer: null,
      userAgent: null,
    });
  });

  it("un header más largo que la columna se trunca en vez de romper con P2000", async () => {
    campaniaFindUniqueMock.mockResolvedValue({ id: 12 });
    eventoCreateMock.mockResolvedValue({ id: 905 });
    const { req, res, next } = buildReqRes({
      params: { id: "12" },
      body: { tipo: "IMPRESION_COMERCIAL", origen: "MODAL" },
      headers: { "user-agent": "x".repeat(1500) },
    });

    await crearDeCampania(req, res, next);

    expect(eventoCreateMock.mock.calls[0][0].data.userAgent).toHaveLength(1000);
  });
});

describe("crearDePromocion", () => {
  it("escribe con promocionId y campaniaId null EXPLÍCITO", async () => {
    promocionFindUniqueMock.mockResolvedValue({ id: 7 });
    eventoCreateMock.mockResolvedValue({ id: 910 });
    const { req, res, next } = buildReqRes({
      params: { id: "7" },
      body: { tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "PROMOCION" },
    });

    await crearDePromocion(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(eventoCreateMock.mock.calls[0][0].data).toMatchObject({
      campaniaId: null,
      promocionId: 7,
      destino: "PROMOCION",
    });
    expect(campaniaFindUniqueMock).not.toHaveBeenCalled();
  });

  it("una promoción inexistente es 404 y NO escribe", async () => {
    promocionFindUniqueMock.mockResolvedValue(null);
    const { req, res, next } = buildReqRes({
      params: { id: "7" },
      body: { tipo: "IMPRESION_COMERCIAL", origen: "BANNER" },
    });

    await crearDePromocion(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));
    expect(eventoCreateMock).not.toHaveBeenCalled();
  });
});
