import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-admin-con-largo-suficiente-32b";
process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.CORS_ORIGIN = "http://localhost:5173";

const findUniqueMock = vi.fn();
const createMock = vi.fn();
const deleteMock = vi.fn();
const deleteManyMock = vi.fn();
const updateMock = vi.fn();
const updateManyMock = vi.fn();
const dispositivoCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: {
      findUnique: (...args) => findUniqueMock(...args),
      create: (...args) => createMock(...args),
      delete: (...args) => deleteMock(...args),
      deleteMany: (...args) => deleteManyMock(...args),
      update: (...args) => updateMock(...args),
      updateMany: (...args) => updateManyMock(...args),
    },
    dispositivoConocido: { create: (...args) => dispositivoCreateMock(...args) },
  },
}));

// El limitador es una instancia de módulo (mismo criterio que
// `ordenes.routes.test.js` y el propio `cuenta.routes.test.js` de la Parte 1):
// se neutraliza en la fábrica, no en `limitadoresCuenta.js`, así las reglas
// reales de esa cola (por IP y por destino) siguen cubiertas aparte en
// `limitadoresCuenta.test.js`.
vi.mock("../middlewares/rateLimit.middleware.js", () => ({
  crearLimitadorDeVelocidad: () => (_req, _res, next) => next(),
}));

const enviarVerificacionMock = vi.fn();
const enviarYaTenesCuentaMock = vi.fn();
vi.mock("../services/notificacionesCuenta.service.js", () => ({
  enviarVerificacion: (...args) => enviarVerificacionMock(...args),
  enviarYaTenesCuenta: (...args) => enviarYaTenesCuentaMock(...args),
  enviarReset: vi.fn(),
  enviarCodigoAcceso: vi.fn(),
  enviarCambioEmail: vi.fn(),
  enviarAvisoCambioEmail: vi.fn(),
}));

const invalidarTokensDeMock = vi.fn();
const consumirTokenMock = vi.fn();
vi.mock("../lib/tokensCuenta.js", () => ({
  invalidarTokensDe: (...args) => invalidarTokensDeMock(...args),
  consumirToken: (...args) => consumirTokenMock(...args),
  // Fake determinista, no el SHA-256 real: los tests de `/verificar` solo
  // afirman el `cuentaClienteId` del `DispositivoConocido`, no su hash.
  hashDeToken: (tokenClaro) => `hash:${tokenClaro}`,
}));

const logErrorMock = vi.fn();
vi.mock("../lib/logError.js", () => ({ logError: (...args) => logErrorMock(...args) }));

const setCookieDispositivoMock = vi.fn();
vi.mock("../lib/cookiesCliente.js", () => ({
  setCookieDispositivo: (...args) => setCookieDispositivoMock(...args),
}));

const { manejadorDeErrores } = await import("../middlewares/errorHandler.js");
const { default: cuentaRouter } = await import("./cuenta.routes.js");
const colaBcrypt = await import("../lib/colaBcrypt.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/cuenta", cuentaRouter);
  app.use((_req, res) => res.status(404).json({ error: "Recurso no encontrado." }));
  app.use(manejadorDeErrores);
  return app;
}

const ORIGIN = "http://localhost:5173";

// La purga global es SIEMPRE el último paso de `procesarRegistro` (todas las
// ramas caen en ella menos la 503 por capacidad, que ni arranca, y la que
// deliberadamente cuelga en el envío). Esperarla es la señal determinista de
// "esta corrida terminó del todo": evita el mismo sleep fijo racy que el
// review marcó en la línea 218 original, acá y en cualquier otro test que
// dispare `procesarRegistro` y no pueda dejar trabajo colgando entre tests
// (dos mocks compartidos — `findUniqueMock`, `deleteManyMock` — se resetean
// recién en el `beforeEach` SIGUIENTE, así que una corrida sin terminar de
// un test se cuela en las aserciones del que sigue).
const esperarPurga = (vecesEsperadas = 1) =>
  vi.waitFor(() => {
    expect(deleteManyMock).toHaveBeenCalledTimes(vecesEsperadas);
  });

beforeEach(() => {
  [
    findUniqueMock,
    createMock,
    deleteMock,
    deleteManyMock,
    updateMock,
    updateManyMock,
    dispositivoCreateMock,
    enviarVerificacionMock,
    enviarYaTenesCuentaMock,
    invalidarTokensDeMock,
    consumirTokenMock,
    logErrorMock,
    setCookieDispositivoMock,
  ].forEach((m) => m.mockReset());
  deleteManyMock.mockResolvedValue({ count: 0 });
  process.env.BCRYPT_CONCURRENCIA = "3";
  colaBcrypt._reiniciarParaTests();
});

describe("router /api/cuenta — cimientos", () => {
  it("existe y responde 404 para una ruta que todavia no esta", async () => {
    const res = await request(buildApp()).get("/api/cuenta/no-existe");
    expect(res.status).toBe(404);
  });

  it("toda mutacion bajo /api/cuenta exige Origin ANTES de cualquier otra cosa", async () => {
    const res = await request(buildApp()).post("/api/cuenta/lo-que-sea").send({});
    expect(res.status).toBe(403);
    expect(res.body.codigo).toBe("ORIGEN_RECHAZADO");
  });

  it("con Origin permitido, una mutacion inexistente llega al 404 (el Origin no la bloqueo)", async () => {
    const res = await request(buildApp()).post("/api/cuenta/lo-que-sea").set("Origin", ORIGIN).send({});
    expect(res.status).toBe(404);
  });
});

const BODY_VALIDO = {
  email: "juan@gmail.com",
  password: "mi perro se llama tobias",
  nombre: "Juan",
  telefono: "1122334455",
  dni: "12345678",
};

describe("POST /api/cuenta/registro", () => {
  it("responde SIEMPRE 200 con el mismo cuerpo — email nuevo y existente-verificado son indistinguibles", async () => {
    findUniqueMock.mockResolvedValueOnce(null); // nuevo
    createMock.mockResolvedValueOnce({ id: 1, ...BODY_VALIDO, emailVerificado: false });
    const resNuevo = await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);

    findUniqueMock.mockResolvedValueOnce({ id: 2, email: "juan@gmail.com", emailVerificado: true }); // existente
    const resExistente = await request(buildApp())
      .post("/api/cuenta/registro")
      .set("Origin", ORIGIN)
      .send(BODY_VALIDO);

    expect(resNuevo.status).toBe(200);
    expect(resExistente.status).toBe(200);
    expect(resNuevo.body).toEqual(resExistente.body);
    expect(resNuevo.body).toEqual({ mensaje: "Te mandamos un mail para confirmar tu cuenta." });

    // Las dos corridas de fondo (crear+enviar, y "ya tenés cuenta"+enviar)
    // terminan cada una en la purga global — dos requests, dos purgas.
    await esperarPurga(2);
  });

  it("email nuevo: crea la cuenta con lista blanca — un body con emailVerificado/tokenVersion/id/origenRegistro NO los pisa", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({ id: 9, email: "juan@gmail.com", nombre: "Juan" });

    await request(buildApp())
      .post("/api/cuenta/registro")
      .set("Origin", ORIGIN)
      .send({ ...BODY_VALIDO, emailVerificado: true, tokenVersion: 99, origenRegistro: "GOOGLE", id: 555 });

    await vi.waitFor(() => {
      expect(createMock).toHaveBeenCalledWith({
        data: {
          email: "juan@gmail.com",
          passwordHash: expect.any(String),
          origenRegistro: "LOCAL",
          nombre: "Juan",
          telefono: "1122334455",
          dni: "12345678",
        },
      });
      expect(enviarVerificacionMock).toHaveBeenCalled();
    });
    await esperarPurga(1);
  });

  it("password de la lista de comunes: 400 con el motivo, sin llegar a tocar la base", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/registro")
      .set("Origin", ORIGIN)
      .send({ ...BODY_VALIDO, password: "12345678" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/muy comun|com[uú]n/i);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("email invalido: 400 sin tocar la base", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/registro")
      .set("Origin", ORIGIN)
      .send({ ...BODY_VALIDO, email: "no-es-un-email" });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("email de mas de 254 caracteres: 400 sin tocar la base (limite del indice UNIQUE)", async () => {
    // Dominio largo (no parte local): así el 400 sale SOLO por el guard de
    // largo y no también, por su cuenta, por la forma que exige `esEmailValido`.
    const emailLargo = `a@${"b".repeat(250)}.com`; // > 254
    const res = await request(buildApp())
      .post("/api/cuenta/registro")
      .set("Origin", ORIGIN)
      .send({ ...BODY_VALIDO, email: emailLargo });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("dni invalido: 400 sin tocar la base", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/registro")
      .set("Origin", ORIGIN)
      .send({ ...BODY_VALIDO, dni: "123" });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("nombre demasiado largo: 400 ANTES de responder (columna NVarChar(1000))", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/registro")
      .set("Origin", ORIGIN)
      .send({ ...BODY_VALIDO, nombre: "a".repeat(1001) });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("telefono demasiado largo: 400 ANTES de responder (columna NVarChar(1000))", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/registro")
      .set("Origin", ORIGIN)
      .send({ ...BODY_VALIDO, telefono: "1".repeat(1001) });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("sin Origin: 403 antes de cualquier otra cosa (segunda capa CSRF)", async () => {
    const res = await request(buildApp()).post("/api/cuenta/registro").send(BODY_VALIDO);
    expect(res.status).toBe(403);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("no verificada y con más de 24 h: se purga (deleteMany por id) y se trata como 'no existe'", async () => {
    const hace25h = new Date(Date.now() - 25 * 60 * 60 * 1000);
    findUniqueMock.mockResolvedValueOnce({ id: 3, email: "juan@gmail.com", emailVerificado: false, createdAt: hace25h });
    createMock.mockResolvedValueOnce({ id: 10, email: "juan@gmail.com", nombre: "Juan" });

    await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);

    await vi.waitFor(() => {
      // `deleteMany` y no `delete`: si la purga global de otra request ya la
      // borró, `delete` lanzaría P2025 y tumbaría este registro.
      expect(deleteManyMock).toHaveBeenCalledWith({ where: { id: 3 } });
      expect(createMock).toHaveBeenCalled();
      expect(enviarVerificacionMock).toHaveBeenCalled();
    });
    expect(deleteMock).not.toHaveBeenCalled();
    // La de la cuenta vencida + la purga global del final.
    await esperarPurga(2);
  });

  it("no verificada y con menos de 24 h: reenvía SIN pisar la contraseña (no llama a create)", async () => {
    const hace1h = new Date(Date.now() - 60 * 60 * 1000);
    findUniqueMock.mockResolvedValueOnce({ id: 4, email: "juan@gmail.com", emailVerificado: false, createdAt: hace1h });

    await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);

    await vi.waitFor(() => {
      expect(enviarVerificacionMock).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
    });
    // La invalidación de los tokens viejos la hace `enviarVerificacion`
    // DESPUÉS de emitir el nuevo; invalidar acá, antes, dejaba la cuenta sin
    // ningún link válido si la emisión fallaba.
    expect(invalidarTokensDeMock).not.toHaveBeenCalled();
    expect(createMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    await esperarPurga(1);
  });

  it("existente y verificada: manda 'ya tenés cuenta', no toca create ni delete", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 5, email: "juan@gmail.com", emailVerificado: true });

    await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);

    await vi.waitFor(() => {
      expect(enviarYaTenesCuentaMock).toHaveBeenCalledWith("juan@gmail.com");
    });
    expect(createMock).not.toHaveBeenCalled();
    await esperarPurga(1);
  });

  it("cola de bcrypt saturada: 503 CAPACIDAD ANTES de mandar ninguna respuesta, sin tocar la base", async () => {
    const liberar1 = await colaBcrypt.reservarSlot();
    const liberar2 = await colaBcrypt.reservarSlot();
    const liberar3 = await colaBcrypt.reservarSlot();

    const res = await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);

    expect(res.status).toBe(503);
    expect(res.body.codigo).toBe("CAPACIDAD");
    expect(findUniqueMock).not.toHaveBeenCalled();

    liberar1();
    liberar2();
    liberar3();
  });

  it("libera el slot de bcrypt apenas termina el hash, sin esperar el envío del mail (un SMTP colgado no debe tumbar el login)", async () => {
    process.env.BCRYPT_CONCURRENCIA = "1";
    colaBcrypt._reiniciarParaTests();

    findUniqueMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({ id: 30, email: "juan@gmail.com", nombre: "Juan" });
    // El mail nunca resuelve durante este test — simula un Gmail colgado/lento.
    enviarVerificacionMock.mockImplementationOnce(() => new Promise(() => {}));

    const res = await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);
    expect(res.status).toBe(200);

    // Con capacidad 1, si el slot siguiera tomado (esperando el mail que
    // nunca llega) esta reserva colgaría hasta el timeout del test.
    await vi.waitFor(async () => {
      const liberar = await colaBcrypt.reservarSlot();
      liberar();
    });
  });

  it("purga GLOBAL oportunista: borra TODAS las cuentas no verificadas vencidas, no solo la del email que llegó (spec, paso 5)", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 6, email: "juan@gmail.com", emailVerificado: true });
    const antes = Date.now();

    await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);

    await esperarPurga(1);
    const [{ where }] = deleteManyMock.mock.calls[0];
    expect(where.emailVerificado).toBe(false);
    // El corte es ~24 h atrás del momento del registro, no un valor fijo.
    const horasAtras = (antes - where.createdAt.lt.getTime()) / (60 * 60 * 1000);
    expect(horasAtras).toBeGreaterThan(23.9);
    expect(horasAtras).toBeLessThan(24.1);
  });

  it("purga global: un error al purgar no rompe nada y se loguea, nunca afecta la respuesta ya enviada", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 7, email: "juan@gmail.com", emailVerificado: true });
    deleteManyMock.mockRejectedValueOnce(new Error("boom"));

    const res = await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(logErrorMock).toHaveBeenCalled();
    });
  });

  it("carrera de alta duplicada (P2002 al crear): se descarta en silencio, sin loguear error — el primer request ya mandó el mail", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const errorDuplicado = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    createMock.mockRejectedValueOnce(errorDuplicado);

    const res = await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);
    expect(res.status).toBe(200);

    // La purga es el paso siguiente al `catch` que descarta el P2002: para
    // cuando se dispara, la rama entera (incluido un eventual logError
    // indeseado) ya corrió — sin esto, un sleep fijo sería tan racy como el
    // que reemplaza.
    await esperarPurga(1);
    expect(logErrorMock).not.toHaveBeenCalled();
    expect(enviarVerificacionMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/cuenta/verificar", () => {
  it("token válido: marca emailVerificado, setea el dispositivo, y NO devuelve sesión", async () => {
    consumirTokenMock.mockResolvedValueOnce({ ok: true, fila: { cuentaClienteId: 11, tipo: "VERIFICACION" } });
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    dispositivoCreateMock.mockResolvedValueOnce({});

    const res = await request(buildApp())
      .post("/api/cuenta/verificar")
      .set("Origin", ORIGIN)
      .send({ token: "TOKEN-CLARO" });

    expect(consumirTokenMock).toHaveBeenCalledWith({ tokenClaro: "TOKEN-CLARO", tipo: "VERIFICACION" });
    const [{ where, data }] = updateManyMock.mock.calls[0];
    expect(data).toEqual({ emailVerificado: true });
    expect(where.id).toBe(11);
    expect(dispositivoCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cuentaClienteId: 11 }) }),
    );
    expect(setCookieDispositivoMock).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("token");
    expect(res.body).not.toHaveProperty("sesion");
  });

  it("token inválido/usado/vencido: 400 con el motivo, sin tocar update ni el dispositivo", async () => {
    consumirTokenMock.mockResolvedValueOnce({ ok: false, motivo: "USADO" });

    const res = await request(buildApp()).post("/api/cuenta/verificar").set("Origin", ORIGIN).send({ token: "x" });

    expect(res.status).toBe(400);
    expect(res.body.motivo).toBe("USADO");
    expect(updateMock).not.toHaveBeenCalled();
    expect(setCookieDispositivoMock).not.toHaveBeenCalled();
  });

  it("cuenta no verificada con más de 24 h: responde EXACTAMENTE como VENCIDO y no la marca verificada", async () => {
    consumirTokenMock.mockResolvedValueOnce({ ok: true, fila: { cuentaClienteId: 12, tipo: "VERIFICACION" } });
    // El `where` guardado no matchea: la cuenta ya salió de la ventana de 24 h.
    updateManyMock.mockResolvedValueOnce({ count: 0 });

    const res = await request(buildApp()).post("/api/cuenta/verificar").set("Origin", ORIGIN).send({ token: "t" });

    consumirTokenMock.mockResolvedValueOnce({ ok: false, motivo: "VENCIDO" });
    const resVencido = await request(buildApp()).post("/api/cuenta/verificar").set("Origin", ORIGIN).send({ token: "t" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(resVencido.body);
    expect(res.body.motivo).toBe("VENCIDO");
    const [{ where }] = updateManyMock.mock.calls[0];
    // La guarda va en el `where` de la escritura (mismo criterio que
    // `stockDescontado`): verificada, o creada dentro de las 24 h.
    const corte = where.OR.find((c) => c.createdAt)?.createdAt.gte;
    expect(where.OR).toContainEqual({ emailVerificado: true });
    expect((Date.now() - corte.getTime()) / (60 * 60 * 1000)).toBeCloseTo(24, 1);
    expect(dispositivoCreateMock).not.toHaveBeenCalled();
    expect(setCookieDispositivoMock).not.toHaveBeenCalled();
  });

  it("si falla registrar el dispositivo conocido, la verificación igual responde 200 y se loguea", async () => {
    consumirTokenMock.mockResolvedValueOnce({ ok: true, fila: { cuentaClienteId: 13, tipo: "VERIFICACION" } });
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    dispositivoCreateMock.mockRejectedValueOnce(new Error("db caida"));

    const res = await request(buildApp()).post("/api/cuenta/verificar").set("Origin", ORIGIN).send({ token: "t" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mensaje: "Tu cuenta está lista. Entrá." });
    expect(logErrorMock).toHaveBeenCalled();
  });

  it("token absurdamente largo: 400 igual que un INVALIDO, sin llegar a hashearlo ni consumirlo", async () => {
    consumirTokenMock.mockResolvedValueOnce({ ok: false, motivo: "INVALIDO" });
    const resInvalido = await request(buildApp()).post("/api/cuenta/verificar").set("Origin", ORIGIN).send({ token: "x" });
    consumirTokenMock.mockClear();

    const res = await request(buildApp())
      .post("/api/cuenta/verificar")
      .set("Origin", ORIGIN)
      .send({ token: "a".repeat(5000) });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(resInvalido.body);
    expect(consumirTokenMock).not.toHaveBeenCalled();
  });

  it("solo existe como POST: un GET no está montado en el router (no puede consumir por prefetch)", async () => {
    const res = await request(buildApp()).get("/api/cuenta/verificar");
    expect(res.status).toBe(404);
  });
});

/**
 * Para la rama de `procesarReenvio` que no llama a ningún mock (cuenta
 * verificada, o inexistente: `return` inmediato tras el único `await` del
 * `findUnique`) no hay ninguna señal positiva para esperar con `vi.waitFor`
 * — a diferencia de `/registro`, acá no hay una purga global al final de la
 * cadena. Un `setImmediate` alcanza: es un tick del event loop, no un sleep
 * por tiempo de pared, y la cadena tiene un solo `await` de por medio.
 */
const esperarUnTick = () => new Promise((resolve) => setImmediate(resolve));

describe("POST /api/cuenta/reenviar-verificacion", () => {
  const BODY = { email: "juan@gmail.com" };

  it("responde SIEMPRE 200 con el mismo mensaje, exista o no la cuenta", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const resInexistente = await request(buildApp())
      .post("/api/cuenta/reenviar-verificacion")
      .set("Origin", ORIGIN)
      .send({ email: "nadie@gmail.com" });

    findUniqueMock.mockResolvedValueOnce({ id: 20, email: "juan@gmail.com", emailVerificado: false, createdAt: new Date() });
    const resExistente = await request(buildApp())
      .post("/api/cuenta/reenviar-verificacion")
      .set("Origin", ORIGIN)
      .send(BODY);

    expect(resInexistente.status).toBe(200);
    expect(resExistente.status).toBe(200);
    expect(resInexistente.body).toEqual(resExistente.body);
  });

  it("existente y no verificada dentro de las 24 h: reenvía (y NO invalida antes de emitir: eso lo hace el sender, después)", async () => {
    const hace1h = new Date(Date.now() - 60 * 60 * 1000);
    findUniqueMock.mockResolvedValueOnce({ id: 21, email: "juan@gmail.com", emailVerificado: false, createdAt: hace1h });

    await request(buildApp()).post("/api/cuenta/reenviar-verificacion").set("Origin", ORIGIN).send(BODY);

    await vi.waitFor(() => {
      expect(enviarVerificacionMock).toHaveBeenCalledWith(expect.objectContaining({ id: 21 }));
    });
    expect(invalidarTokensDeMock).not.toHaveBeenCalled();
  });

  it("no verificada con más de 24 h: NO reenvía — un reenvío a las 23:59 estiraba la cuenta a ~48 h", async () => {
    const hace25h = new Date(Date.now() - 25 * 60 * 60 * 1000);
    findUniqueMock.mockResolvedValueOnce({ id: 23, email: "juan@gmail.com", emailVerificado: false, createdAt: hace25h });

    await request(buildApp()).post("/api/cuenta/reenviar-verificacion").set("Origin", ORIGIN).send(BODY);
    await esperarUnTick();

    expect(enviarVerificacionMock).not.toHaveBeenCalled();
  });

  it("ya verificada: no reenvía nada (no es 'olvidé mi contraseña')", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 22, email: "juan@gmail.com", emailVerificado: true });

    await request(buildApp()).post("/api/cuenta/reenviar-verificacion").set("Origin", ORIGIN).send(BODY);
    await esperarUnTick();

    expect(invalidarTokensDeMock).not.toHaveBeenCalled();
    expect(enviarVerificacionMock).not.toHaveBeenCalled();
  });

  it("cuenta inexistente: no toca invalidarTokensDe ni enviarVerificacion", async () => {
    findUniqueMock.mockResolvedValueOnce(null);

    await request(buildApp()).post("/api/cuenta/reenviar-verificacion").set("Origin", ORIGIN).send(BODY);
    await esperarUnTick();

    expect(invalidarTokensDeMock).not.toHaveBeenCalled();
    expect(enviarVerificacionMock).not.toHaveBeenCalled();
  });

  it("email inválido: 400 sin tocar la base (mismo criterio de /registro)", async () => {
    const res = await request(buildApp())
      .post("/api/cuenta/reenviar-verificacion")
      .set("Origin", ORIGIN)
      .send({ email: "no-es-un-email" });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("email de más de 254 caracteres: 400 sin tocar la base", async () => {
    const emailLargo = `a@${"b".repeat(250)}.com`;
    const res = await request(buildApp())
      .post("/api/cuenta/reenviar-verificacion")
      .set("Origin", ORIGIN)
      .send({ email: emailLargo });
    expect(res.status).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("sin Origin: 403 antes de cualquier otra cosa (segunda capa CSRF)", async () => {
    const res = await request(buildApp()).post("/api/cuenta/reenviar-verificacion").send(BODY);
    expect(res.status).toBe(403);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});
