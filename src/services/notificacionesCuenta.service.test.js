import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const enviarMailMock = vi.fn();
const logErrorMock = vi.fn();
const emitirTokenMock = vi.fn();
const invalidarTokensDeMock = vi.fn();

vi.mock("./email.service.js", () => ({ enviarMail: (...args) => enviarMailMock(...args) }));
vi.mock("../lib/logError.js", () => ({ logError: (...args) => logErrorMock(...args) }));
vi.mock("../lib/tokensCuenta.js", () => ({
  emitirToken: (...args) => emitirTokenMock(...args),
  invalidarTokensDe: (...args) => invalidarTokensDeMock(...args),
  // Fake determinista: acá solo importa que el `excepto` sea el hash del token recién emitido.
  hashDeToken: (tokenClaro) => `hash:${tokenClaro}`,
}));

const {
  enviarVerificacion,
  enviarCodigoAcceso,
  enviarReset,
  enviarCambioEmail,
  enviarAvisoCambioEmail,
  enviarYaTenesCuenta,
} = await import("./notificacionesCuenta.service.js");

const CUENTA = { id: 7, email: "cliente@gmail.com", nombre: "Juan" };
const ENTORNO_ORIGINAL = { ...process.env };

beforeEach(() => {
  enviarMailMock.mockReset();
  enviarMailMock.mockResolvedValue(undefined);
  logErrorMock.mockReset();
  emitirTokenMock.mockReset();
  emitirTokenMock.mockResolvedValue({ tokenClaro: "TOKEN-XYZ", expiraEn: new Date() });
  invalidarTokensDeMock.mockReset();
  invalidarTokensDeMock.mockResolvedValue(undefined);
  process.env.FRONTEND_URL = "https://yima-productos.com";
});

afterEach(() => {
  process.env = { ...ENTORNO_ORIGINAL };
});

describe("enviarVerificacion", () => {
  it("emite un token de tipo VERIFICACION y lo manda por mail con categoria 'resto'", async () => {
    await enviarVerificacion(CUENTA);
    expect(emitirTokenMock).toHaveBeenCalledWith({ cuentaClienteId: 7, tipo: "VERIFICACION" });
    expect(enviarMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ para: "cliente@gmail.com", categoria: "resto" }),
    );
    const html = enviarMailMock.mock.calls[0][0].html;
    expect(html).toContain("TOKEN-XYZ");
  });

  it("nunca lanza: si emitirToken falla, loguea y no propaga", async () => {
    emitirTokenMock.mockRejectedValue(new Error("db caida"));
    await expect(enviarVerificacion(CUENTA)).resolves.toBeUndefined();
    expect(logErrorMock).toHaveBeenCalled();
  });

  it("invalida los VERIFICACION anteriores DESPUÉS de emitir el nuevo, dejando vivo solo el nuevo", async () => {
    const orden = [];
    emitirTokenMock.mockImplementation(async () => {
      orden.push("emitir");
      return { tokenClaro: "TOKEN-XYZ", expiraEn: new Date() };
    });
    invalidarTokensDeMock.mockImplementation(async () => {
      orden.push("invalidar");
    });

    await enviarVerificacion(CUENTA);

    expect(orden).toEqual(["emitir", "invalidar"]);
    expect(invalidarTokensDeMock).toHaveBeenCalledWith(7, "VERIFICACION", { excepto: "hash:TOKEN-XYZ" });
  });

  it("si emitir falla, NO invalida los anteriores: el link viejo sigue sirviendo", async () => {
    emitirTokenMock.mockRejectedValue(new Error("db caida"));
    await enviarVerificacion(CUENTA);
    expect(invalidarTokensDeMock).not.toHaveBeenCalled();
  });
});

describe("enviarCodigoAcceso", () => {
  it("manda el código recibido con categoria 'acceso' y su vencimiento, para que la cola no lo mande vencido", async () => {
    const expiraEn = new Date(Date.now() + 10 * 60 * 1000);
    await enviarCodigoAcceso(CUENTA, { codigo: "482913", expiraEn });
    expect(enviarMailMock).toHaveBeenCalledWith(expect.objectContaining({ categoria: "acceso", expiraEn }));
    expect(enviarMailMock.mock.calls[0][0].html).toContain("482913");
  });
});

describe("enviarReset — vencimiento", () => {
  it("manda el token recibido y le pasa su vencimiento a enviarMail", async () => {
    const expiraEn = new Date(Date.now() + 60 * 60 * 1000);
    await enviarReset(CUENTA, { tokenClaro: "RESET-1", expiraEn });
    expect(enviarMailMock).toHaveBeenCalledWith(expect.objectContaining({ categoria: "acceso", expiraEn }));
    expect(enviarMailMock.mock.calls[0][0].html).toContain("RESET-1");
  });
});

describe("enviarReset — el único que reintenta", () => {
  it("reintenta 3 veces con backoff 2s/8s y luego se rinde sin lanzar", async () => {
    vi.useFakeTimers();
    try {
      enviarMailMock.mockRejectedValue(new Error("smtp caido"));
      const promesa = enviarReset(CUENTA, { tokenClaro: "RESET-1", expiraEn: new Date(Date.now() + 3_600_000) });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(8000);
      await promesa;
      expect(enviarMailMock).toHaveBeenCalledTimes(3);
      expect(logErrorMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("si el segundo intento funciona, no hay tercer intento ni log de error", async () => {
    vi.useFakeTimers();
    try {
      enviarMailMock.mockRejectedValueOnce(new Error("smtp caido")).mockResolvedValueOnce(undefined);
      const promesa = enviarReset(CUENTA, { tokenClaro: "RESET-1", expiraEn: new Date(Date.now() + 3_600_000) });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);
      await promesa;
      expect(enviarMailMock).toHaveBeenCalledTimes(2);
      expect(logErrorMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("enviarCambioEmail / enviarAvisoCambioEmail / enviarYaTenesCuenta", () => {
  it("el cambio de email va a la dirección NUEVA", async () => {
    await enviarCambioEmail(CUENTA, { emailNuevo: "nuevo@gmail.com", tokenClaro: "CE-1" });
    expect(enviarMailMock).toHaveBeenCalledWith(expect.objectContaining({ para: "nuevo@gmail.com" }));
  });

  it("el aviso de cambio va a la dirección VIEJA (la de la cuenta)", async () => {
    await enviarAvisoCambioEmail(CUENTA, { emailNuevo: "nuevo@gmail.com" });
    expect(enviarMailMock).toHaveBeenCalledWith(expect.objectContaining({ para: "cliente@gmail.com" }));
  });

  it("ya-tenés-cuenta va al email pasado por parámetro, no requiere la fila completa", async () => {
    await enviarYaTenesCuenta("otro@gmail.com");
    expect(enviarMailMock).toHaveBeenCalledWith(expect.objectContaining({ para: "otro@gmail.com" }));
  });
});
