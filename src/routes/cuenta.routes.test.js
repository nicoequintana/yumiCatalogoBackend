import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

process.env.JWT_SECRET = "test-secret-admin-con-largo-suficiente-32b";
process.env.JWT_SECRET_CLIENTE = "test-secret-cliente-con-largo-suficiente";
process.env.CORS_ORIGIN = "http://localhost:5173";

const findUniqueMock = vi.fn();
const createMock = vi.fn();
const deleteMock = vi.fn();
const updateMock = vi.fn();
const dispositivoCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    cuentaCliente: {
      findUnique: (...args) => findUniqueMock(...args),
      create: (...args) => createMock(...args),
      delete: (...args) => deleteMock(...args),
      update: (...args) => updateMock(...args),
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

// El envío es fire-and-forget FUERA del camino de la respuesta: hay que
// esperar un tick para que el mock de notificaciones se haya llamado.
const esperarUnTick = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  [
    findUniqueMock,
    createMock,
    deleteMock,
    updateMock,
    dispositivoCreateMock,
    enviarVerificacionMock,
    enviarYaTenesCuentaMock,
    invalidarTokensDeMock,
    consumirTokenMock,
  ].forEach((m) => m.mockReset());
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
  });

  it("email nuevo: crea la cuenta con lista blanca — un body con emailVerificado/tokenVersion/id/origenRegistro NO los pisa", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({ id: 9, email: "juan@gmail.com", nombre: "Juan" });

    await request(buildApp())
      .post("/api/cuenta/registro")
      .set("Origin", ORIGIN)
      .send({ ...BODY_VALIDO, emailVerificado: true, tokenVersion: 99, origenRegistro: "GOOGLE", id: 555 });
    await esperarUnTick();

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
    const emailLargo = `${"a".repeat(250)}@x.com`; // > 254
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

  it("sin Origin: 403 antes de cualquier otra cosa (segunda capa CSRF)", async () => {
    const res = await request(buildApp()).post("/api/cuenta/registro").send(BODY_VALIDO);
    expect(res.status).toBe(403);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("no verificada y con más de 24 h: se purga (delete) y se trata como 'no existe'", async () => {
    const hace25h = new Date(Date.now() - 25 * 60 * 60 * 1000);
    findUniqueMock.mockResolvedValueOnce({ id: 3, email: "juan@gmail.com", emailVerificado: false, createdAt: hace25h });
    createMock.mockResolvedValueOnce({ id: 10, email: "juan@gmail.com", nombre: "Juan" });

    await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);
    await esperarUnTick();

    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 3 } });
    expect(createMock).toHaveBeenCalled();
    expect(enviarVerificacionMock).toHaveBeenCalled();
  });

  it("no verificada y con menos de 24 h: reenvía SIN pisar la contraseña (no llama a create)", async () => {
    const hace1h = new Date(Date.now() - 60 * 60 * 1000);
    findUniqueMock.mockResolvedValueOnce({ id: 4, email: "juan@gmail.com", emailVerificado: false, createdAt: hace1h });

    await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);
    await esperarUnTick();

    expect(createMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(invalidarTokensDeMock).toHaveBeenCalledWith(4, "VERIFICACION");
    expect(enviarVerificacionMock).toHaveBeenCalled();
  });

  it("existente y verificada: manda 'ya tenés cuenta', no toca create ni delete", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: 5, email: "juan@gmail.com", emailVerificado: true });

    await request(buildApp()).post("/api/cuenta/registro").set("Origin", ORIGIN).send(BODY_VALIDO);
    await esperarUnTick();

    expect(createMock).not.toHaveBeenCalled();
    expect(enviarYaTenesCuentaMock).toHaveBeenCalledWith("juan@gmail.com");
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
});
