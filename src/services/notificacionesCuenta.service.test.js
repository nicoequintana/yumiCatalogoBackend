import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const enviarMailMock = vi.fn();
const logErrorMock = vi.fn();
const emitirTokenMock = vi.fn();

vi.mock("./email.service.js", () => ({ enviarMail: (...args) => enviarMailMock(...args) }));
vi.mock("../lib/logError.js", () => ({ logError: (...args) => logErrorMock(...args) }));
vi.mock("../lib/tokensCuenta.js", () => ({ emitirToken: (...args) => emitirTokenMock(...args) }));

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
});

describe("enviarCodigoAcceso", () => {
  it("manda el código recibido con categoria 'acceso'", async () => {
    await enviarCodigoAcceso(CUENTA, "482913");
    expect(enviarMailMock).toHaveBeenCalledWith(expect.objectContaining({ categoria: "acceso" }));
    expect(enviarMailMock.mock.calls[0][0].html).toContain("482913");
  });
});

describe("enviarReset — el único que reintenta", () => {
  it("reintenta 3 veces con backoff 2s/8s y luego se rinde sin lanzar", async () => {
    vi.useFakeTimers();
    try {
      enviarMailMock.mockRejectedValue(new Error("smtp caido"));
      const promesa = enviarReset(CUENTA, "RESET-1");
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
      const promesa = enviarReset(CUENTA, "RESET-1");
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
