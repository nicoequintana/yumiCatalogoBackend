import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

process.env.JWT_SECRET = "test-secret";
process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente-32";
process.env.COOKIE_DOMINIO = "";

const findUniqueMock = vi.fn();
const updateManyMock = vi.fn();
const findFirstDispMock = vi.fn();
const tokenUpdateManyMock = vi.fn();
const tokenCreateMock = vi.fn();
const enviarCodigoAccesoMock = vi.fn();
const errorLogCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: { findUnique: (...a) => findUniqueMock(...a), updateMany: (...a) => updateManyMock(...a) },
    dispositivoConocido: { findFirst: (...a) => findFirstDispMock(...a) },
    tokenCuenta: { updateMany: (...a) => tokenUpdateManyMock(...a), create: (...a) => tokenCreateMock(...a) },
    errorLog: { create: (...a) => errorLogCreateMock(...a) },
  },
}));
vi.mock("../services/notificacionesCuenta.service.js", () => ({
  enviarCodigoAcceso: (...a) => enviarCodigoAccesoMock(...a),
  enviarVerificacion: vi.fn(),
  enviarYaTenesCuenta: vi.fn(),
}));
// Spy, no reemplazo total: se necesita el comportamiento real de la cola.
vi.mock("../lib/colaBcrypt.js", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, reservarSlot: vi.fn(real.reservarSlot), estaBajoPresion: vi.fn(real.estaBajoPresion) };
});

const { login } = await import("./cuenta.controller.js");
const { manejadorDeErrores } = await import("../middlewares/errorHandler.js");
const cola = await import("../lib/colaBcrypt.js");
const { reservarSlot, estaBajoPresion } = cola;
const { hashearPassword } = await import("../lib/passwords.js");
const { MAX_INTENTOS_LOGIN, HORAS_PURGA_NO_VERIFICADAS } = await import("../lib/cuentasCliente.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post("/login", login);
  app.use(manejadorDeErrores);
  return app;
}

const CLAVE = "una-clave-bien-larga";
const CUERPO_GENERICO = { error: "Email o contraseña incorrectos." };
let HASH;

function cuentaVerificada(extra = {}) {
  return {
    id: 1, email: "x@gmail.com", passwordHash: HASH, emailVerificado: true,
    bloqueadoHasta: null, tokenVersion: 0, createdAt: new Date(), ...extra,
  };
}

/** Envuelve el `liberar` real para saber en qué momento se soltó el slot. */
function espiarLiberacion() {
  const estado = { liberado: false };
  const real = reservarSlot.getMockImplementation();
  reservarSlot.mockImplementationOnce(async () => {
    const liberar = await real();
    return () => {
      estado.liberado = true;
      liberar();
    };
  });
  return estado;
}

beforeEach(async () => {
  cola._reiniciarParaTests();
  findUniqueMock.mockReset();
  updateManyMock.mockReset().mockResolvedValue({ count: 1 });
  findFirstDispMock.mockReset().mockResolvedValue(null);
  tokenUpdateManyMock.mockReset().mockResolvedValue({ count: 0 });
  tokenCreateMock.mockReset().mockResolvedValue({});
  enviarCodigoAccesoMock.mockReset().mockResolvedValue(undefined);
  errorLogCreateMock.mockReset().mockResolvedValue({});
  reservarSlot.mockClear();
  estaBajoPresion.mockClear();
  HASH = HASH ?? (await hashearPassword(CLAVE));
});

describe("login — validación de entrada antes de la base y de bcrypt", () => {
  it.each([
    ["email no string", { email: 123, password: CLAVE }],
    ["email de más de 254 caracteres", { email: `${"a".repeat(250)}@gmail.com`, password: CLAVE }],
    ["password no string", { email: "x@gmail.com", password: ["a"] }],
    ["sin body", {}],
  ])("%s → 400 sin reservar slot ni consultar", async (_caso, body) => {
    const res = await request(buildApp()).post("/login").send(body);
    expect(res.status).toBe(400);
    expect(reservarSlot).not.toHaveBeenCalled();
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

describe("login — aislamiento: mismo cuerpo para los tres casos", () => {
  it("cuenta inexistente", async () => {
    findUniqueMock.mockResolvedValue(null);
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CUERPO_GENERICO);
  });

  it("cuenta no verificada (dentro de las 24 h): 401 y cuenta el fallo", async () => {
    findUniqueMock.mockResolvedValue(cuentaVerificada({ emailVerificado: false }));
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CUERPO_GENERICO);
    await vi.waitFor(() => expect(updateManyMock).toHaveBeenCalled());
  });

  it("no verificada de más de 24 h: igual que inexistente (401, corre bcrypt, NO escribe)", async () => {
    const vieja = new Date(Date.now() - (HORAS_PURGA_NO_VERIFICADAS * 60 + 1) * 60 * 1000);
    findUniqueMock.mockResolvedValue(cuentaVerificada({ emailVerificado: false, createdAt: vieja }));
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CUERPO_GENERICO);
    await new Promise((r) => setTimeout(r, 50));
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("cuenta bloqueada", async () => {
    findUniqueMock.mockResolvedValue(cuentaVerificada({ bloqueadoHasta: new Date(Date.now() + 60_000) }));
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CUERPO_GENERICO);
  });

  it("cuenta de Google sin passwordHash: 401 genérico, no 500", async () => {
    findUniqueMock.mockResolvedValue(cuentaVerificada({ passwordHash: null }));
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(401);
    expect(res.body).toEqual(CUERPO_GENERICO);
  });

  it("los cinco 401 son idénticos: status, cuerpo y Set-Cookie (ninguno)", async () => {
    const vieja = new Date(Date.now() - (HORAS_PURGA_NO_VERIFICADAS * 60 + 1) * 60 * 1000);
    const casos = [
      [null, CLAVE],
      [cuentaVerificada({ emailVerificado: false }), CLAVE],
      [cuentaVerificada({ emailVerificado: false, createdAt: vieja }), CLAVE],
      [cuentaVerificada({ bloqueadoHasta: new Date(Date.now() + 60_000) }), CLAVE],
      [cuentaVerificada(), "mal"],
    ];
    const respuestas = [];
    for (const [cuenta, password] of casos) {
      findUniqueMock.mockResolvedValueOnce(cuenta);
      const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password });
      respuestas.push({ status: res.status, body: res.body, cookies: res.headers["set-cookie"] ?? null });
    }
    for (const r of respuestas) expect(r).toEqual({ status: 401, body: CUERPO_GENERICO, cookies: null });
  });

  it("el 401 NO espera las escrituras del contador (el tiempo no distingue cuenta existente)", async () => {
    updateManyMock.mockReturnValue(new Promise(() => {}));
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: "mal" });
    expect(res.status).toBe(401);
  });

  it("si registrarFallo falla, el 401 sale igual y el error se loguea (sin rechazo sin manejar)", async () => {
    updateManyMock.mockRejectedValue(new Error("base caida"));
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: "mal" });
    expect(res.status).toBe(401);
    // El errorHandler también loguea el 401: se busca el log PROPIO del fallo.
    await vi.waitFor(() => expect(JSON.stringify(errorLogCreateMock.mock.calls)).toContain("registrar el fallo de login"));
  });

  it("si enviarCodigoAcceso rechaza, el 200 sale igual y el error se loguea (sin rechazo sin manejar)", async () => {
    enviarCodigoAccesoMock.mockRejectedValue(new Error("smtp caido"));
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.body).toEqual({ requiereCodigo: true });
    await vi.waitFor(() => expect(JSON.stringify(errorLogCreateMock.mock.calls)).toContain("enviar el código de acceso"));
  });
});

describe("login — bloqueo persistido", () => {
  it("fallo común: reinicio vencido no escribe (count 0) → incremento → bloqueo guardado en el where", async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: "mal" });
    await vi.waitFor(() => expect(updateManyMock).toHaveBeenCalledTimes(3));
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: 1, bloqueadoHasta: { lt: expect.any(Date) } },
      data: { intentosFallidos: 1, bloqueadoHasta: null },
    });
    expect(updateManyMock.mock.calls[1][0]).toEqual({ where: { id: 1 }, data: { intentosFallidos: { increment: 1 } } });
    expect(updateManyMock.mock.calls[2][0].where).toEqual({
      id: 1, intentosFallidos: { gte: MAX_INTENTOS_LOGIN }, bloqueadoHasta: null,
    });
    expect(updateManyMock.mock.calls[2][0].data.bloqueadoHasta).toBeInstanceOf(Date);
  });

  it("bloqueo vencido + clave mal: el contador arranca en 1 y NO se re-bloquea", async () => {
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    findUniqueMock.mockResolvedValue(cuentaVerificada({ bloqueadoHasta: new Date(Date.now() - 1000), intentosFallidos: 10 }));
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: "mal" });
    expect(res.status).toBe(401);
    await vi.waitFor(() => expect(updateManyMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0].data).toEqual({ intentosFallidos: 1, bloqueadoHasta: null });
  });

  it("un bloqueo ACTIVO nunca se extiende: la escritura de bloqueo exige bloqueadoHasta null", async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    findUniqueMock.mockResolvedValue(cuentaVerificada({ bloqueadoHasta: new Date(Date.now() + 60_000) }));
    await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    await vi.waitFor(() => expect(updateManyMock).toHaveBeenCalledTimes(3));
    expect(updateManyMock.mock.calls[2][0].where.bloqueadoHasta).toBeNull();
  });

  it("el 11.o intento CON LA CLAVE CORRECTA sigue dando 401 (la cuenta ya esta bloqueada)", async () => {
    findUniqueMock.mockResolvedValue(cuentaVerificada({ bloqueadoHasta: new Date(Date.now() + 60_000) }));
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(401);
    expect(enviarCodigoAccesoMock).not.toHaveBeenCalled();
  });

  it("éxito resetea contador y bloqueo", async () => {
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    findFirstDispMock.mockResolvedValue({ id: 9 });
    await request(buildApp()).post("/login").set("Cookie", "dispositivo_cliente=algo").send({ email: "x@gmail.com", password: CLAVE });
    expect(updateManyMock).toHaveBeenCalledWith({ where: { id: 1 }, data: { intentosFallidos: 0, bloqueadoHasta: null } });
  });
});

describe("login — exito", () => {
  it("dispositivo desconocido: emite codigo, manda mail, responde requiereCodigo SIN cookie de sesion", async () => {
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requiereCodigo: true });
    expect(tokenCreateMock).toHaveBeenCalledTimes(1);
    expect(enviarCodigoAccesoMock).toHaveBeenCalledTimes(1);
    const [cuentaArg, { codigo, expiraEn }] = enviarCodigoAccesoMock.mock.calls[0];
    expect(cuentaArg).toMatchObject({ id: 1, email: "x@gmail.com" });
    expect(codigo).toMatch(/^\d{6}$/);
    expect(expiraEn).toBeInstanceOf(Date);
    expect((res.headers["set-cookie"] ?? []).some((c) => c.startsWith("sesion_cliente="))).toBe(false);
  });

  it("dispositivo conocido: busca la fila viva de ESA cuenta, setea cookie de sesion y responde ok", async () => {
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    findFirstDispMock.mockResolvedValue({ id: 9 });
    const res = await request(buildApp()).post("/login").set("Cookie", "dispositivo_cliente=algo").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["set-cookie"].some((c) => c.startsWith("sesion_cliente="))).toBe(true);
    expect(findFirstDispMock.mock.calls[0][0].where).toMatchObject({ cuentaClienteId: 1, expiraEn: { gt: expect.any(Date) } });
    expect(enviarCodigoAccesoMock).not.toHaveBeenCalled();
  });

  it("cookie de dispositivo que no matchea: pide código", async () => {
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    const res = await request(buildApp()).post("/login").set("Cookie", "dispositivo_cliente=ajena").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.body).toEqual({ requiereCodigo: true });
  });
});

describe("login — cola de bcrypt", () => {
  it("reservarSlot se llama ANTES del findUnique", async () => {
    findUniqueMock.mockResolvedValue(null);
    await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(reservarSlot.mock.invocationCallOrder[0]).toBeLessThan(findUniqueMock.mock.invocationCallOrder[0]);
  });

  it("con la cola llena: 503 CAPACIDAD sin tocar la base", async () => {
    reservarSlot.mockRejectedValueOnce(Object.assign(new Error("lleno"), { status: 503, codigo: "CAPACIDAD" }));
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(503);
    expect(res.body.codigo).toBe("CAPACIDAD");
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("el slot se libera ANTES de registrar el fallo", async () => {
    const estado = espiarLiberacion();
    const liberadoAlEscribir = [];
    updateManyMock.mockImplementation(async () => {
      liberadoAlEscribir.push(estado.liberado);
      return { count: 0 };
    });
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: "mal" });
    await vi.waitFor(() => expect(liberadoAlEscribir).toEqual([true, true, true]));
  });

  it("el slot se libera ANTES del reset, del dispositivo y del código", async () => {
    const estado = espiarLiberacion();
    const liberado = [];
    updateManyMock.mockImplementation(async () => (liberado.push(estado.liberado), { count: 1 }));
    findFirstDispMock.mockImplementation(async () => (liberado.push(estado.liberado), null));
    tokenCreateMock.mockImplementation(async () => (liberado.push(estado.liberado), {}));
    findUniqueMock.mockResolvedValue(cuentaVerificada());
    await request(buildApp()).post("/login").set("Cookie", "dispositivo_cliente=algo").send({ email: "x@gmail.com", password: CLAVE });
    expect(liberado.length).toBeGreaterThanOrEqual(3);
    expect(liberado.every(Boolean)).toBe(true);
  });

  it("el slot se libera aunque falle la consulta", async () => {
    const estado = espiarLiberacion();
    findUniqueMock.mockRejectedValue(new Error("base caida"));
    const res = await request(buildApp()).post("/login").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(500);
    expect(estado.liberado).toBe(true);
  });

  it("bajo presion NO re-hashea aunque el hash sea viejo", async () => {
    const { hashSync } = await import("bcryptjs");
    const hashViejo = hashSync(CLAVE, 4);
    findUniqueMock.mockResolvedValue(cuentaVerificada({ passwordHash: hashViejo }));
    findFirstDispMock.mockResolvedValue({ id: 9 });
    estaBajoPresion.mockReturnValueOnce(true);
    await request(buildApp()).post("/login").set("Cookie", "dispositivo_cliente=algo").send({ email: "x@gmail.com", password: CLAVE });
    await new Promise((r) => setTimeout(r, 50));
    expect(estaBajoPresion).toHaveBeenCalled();
    expect(updateManyMock.mock.calls.every((c) => !("passwordHash" in (c[0].data ?? {})))).toBe(true);
  });

  it("sin presion re-hashea DESPUES de responder, con el hash viejo en el where", async () => {
    const { hashSync } = await import("bcryptjs");
    const hashViejo = hashSync(CLAVE, 4);
    findUniqueMock.mockResolvedValue(cuentaVerificada({ passwordHash: hashViejo }));
    findFirstDispMock.mockResolvedValue({ id: 9 });
    const res = await request(buildApp()).post("/login").set("Cookie", "dispositivo_cliente=algo").send({ email: "x@gmail.com", password: CLAVE });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      const rehash = updateManyMock.mock.calls.find((c) => "passwordHash" in (c[0].data ?? {}));
      expect(rehash?.[0].where).toEqual({ id: 1, passwordHash: hashViejo });
    });
  });
});
