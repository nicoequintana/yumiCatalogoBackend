import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const enviarMailMock = vi.fn();
vi.mock("./email.service.js", () => ({
  enviarMail: (...args) => enviarMailMock(...args),
}));

const { alertarError, VENTANA_AGRUPACION_MS, _resetearParaTests } = await import(
  "./alertaErrores.service.js"
);

beforeEach(() => {
  enviarMailMock.mockReset();
  enviarMailMock.mockResolvedValue(undefined);
  _resetearParaTests();
  process.env.MAIL_ADMIN_DESTINO = "admin@yima.test";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-02T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

const ERROR_BASE = { mensaje: "Cloudinary devolvió 502", ruta: "/api/products", metodo: "POST", status: 500 };

describe("alertarError", () => {
  it("manda un mail al admin cuando entra un error", async () => {
    await alertarError(ERROR_BASE);

    expect(enviarMailMock).toHaveBeenCalledTimes(1);
    const [{ para, asunto, texto }] = enviarMailMock.mock.calls[0];
    expect(para).toBe("admin@yima.test");
    expect(asunto).toContain("Cloudinary devolvió 502");
    expect(texto).toContain("POST");
    expect(texto).toContain("/api/products");
  });

  // LA REGLA QUE HACE USABLE LA ALERTA. Un fallo de Cloudinary o de la base no
  // llega solo: llega como una ráfaga. Sin agrupación, un incidente de dos
  // minutos manda cientos de mails, la casilla se vuelve inservible y la
  // alerta se ignora — que es peor que no tenerla.
  it("agrupa los errores de la misma ventana en un solo mail", async () => {
    await alertarError(ERROR_BASE);
    await alertarError(ERROR_BASE);
    await alertarError({ ...ERROR_BASE, mensaje: "Otro error distinto" });

    expect(enviarMailMock).toHaveBeenCalledTimes(1);
  });

  it("informa cuántos errores se suprimieron, en el mail siguiente", async () => {
    await alertarError(ERROR_BASE);
    await alertarError(ERROR_BASE);
    await alertarError(ERROR_BASE);

    vi.advanceTimersByTime(VENTANA_AGRUPACION_MS + 1);
    await alertarError({ ...ERROR_BASE, mensaje: "Error posterior" });

    expect(enviarMailMock).toHaveBeenCalledTimes(2);
    const [{ texto }] = enviarMailMock.mock.calls[1];
    expect(texto).toContain("2");
  });

  it("vuelve a alertar una vez pasada la ventana", async () => {
    await alertarError(ERROR_BASE);
    vi.advanceTimersByTime(VENTANA_AGRUPACION_MS + 1);
    await alertarError(ERROR_BASE);

    expect(enviarMailMock).toHaveBeenCalledTimes(2);
  });

  // MISMO CONTRATO QUE logError: esto corre en el camino de un error que ya
  // ocurrió. Si la alerta lanzara, rompería el manejo del error original —
  // convertiría un 500 registrado en un proceso caído.
  it("nunca lanza aunque el envío falle", async () => {
    enviarMailMock.mockRejectedValue(new Error("SMTP caído"));

    await expect(alertarError(ERROR_BASE)).resolves.toBeUndefined();
  });

  it("nunca lanza aunque falte MAIL_ADMIN_DESTINO", async () => {
    delete process.env.MAIL_ADMIN_DESTINO;

    await expect(alertarError(ERROR_BASE)).resolves.toBeUndefined();
    expect(enviarMailMock).not.toHaveBeenCalled();
  });

  // El stack puede llevar rutas del servidor y fragmentos de query. Va al mail
  // porque es lo que hace accionable la alerta, pero recortado: un stack
  // completo de Prisma son miles de caracteres y vuelve el mail ilegible.
  it("recorta el stack para que el mail siga siendo legible", async () => {
    await alertarError({ ...ERROR_BASE, stack: "x".repeat(5000) });

    const [{ texto }] = enviarMailMock.mock.calls[0];
    expect(texto.length).toBeLessThan(3000);
  });
});
