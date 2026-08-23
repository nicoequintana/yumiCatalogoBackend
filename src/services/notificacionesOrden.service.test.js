import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const enviarMailMock = vi.fn();
const logErrorMock = vi.fn();

vi.mock("./email.service.js", () => ({
  enviarMail: (...args) => enviarMailMock(...args),
}));

vi.mock("../lib/logError.js", () => ({
  logError: (...args) => logErrorMock(...args),
}));

const { notificarOrdenCreada, notificarCambioEstado } = await import(
  "./notificacionesOrden.service.js"
);

const ORDEN = {
  id: 42,
  estado: "PENDIENTE",
  notas: null,
  cliente: { dni: "12345678", nombre: "Juan Pérez", telefono: "1122334455", email: "juan@gmail.com" },
  items: [{ nombreProducto: "Difusor", precioUnitario: "8000.00", cantidad: 1 }],
};

const ENTORNO_ORIGINAL = { ...process.env };

beforeEach(() => {
  enviarMailMock.mockReset();
  enviarMailMock.mockResolvedValue(undefined);
  logErrorMock.mockReset();
  process.env.MAIL_ADMIN_DESTINO = "yimaproductos@gmail.com";
  process.env.FRONTEND_URL = "https://yima.test";
});

afterEach(() => {
  process.env = { ...ENTORNO_ORIGINAL };
});

describe("notificarOrdenCreada", () => {
  it("manda dos mails: al cliente y a la casilla de YIMA", async () => {
    await notificarOrdenCreada(ORDEN);

    expect(enviarMailMock).toHaveBeenCalledTimes(2);
    const destinos = enviarMailMock.mock.calls.map(([m]) => m.para);
    expect(destinos).toContain("juan@gmail.com");
    expect(destinos).toContain("yimaproductos@gmail.com");
  });

  it("arma el link del panel desde FRONTEND_URL", async () => {
    await notificarOrdenCreada(ORDEN);

    const alAdmin = enviarMailMock.mock.calls.find(([m]) => m.para === "yimaproductos@gmail.com")[0];
    expect(alAdmin.texto).toContain("https://yima.test/catalogo/admin/ordenes/42");
  });

  it("no duplica la barra si FRONTEND_URL termina en /", async () => {
    process.env.FRONTEND_URL = "https://yima.test/";
    await notificarOrdenCreada(ORDEN);

    const alAdmin = enviarMailMock.mock.calls.find(([m]) => m.para === "yimaproductos@gmail.com")[0];
    expect(alAdmin.texto).toContain("https://yima.test/catalogo/admin/ordenes/42");
    expect(alAdmin.texto).not.toContain("yima.test//catalogo");
  });

  it("manda igual el de YIMA cuando el cliente no tiene email", async () => {
    const sinEmail = { ...ORDEN, cliente: { ...ORDEN.cliente, email: null } };
    await notificarOrdenCreada(sinEmail);

    expect(enviarMailMock).toHaveBeenCalledTimes(1);
    expect(enviarMailMock.mock.calls[0][0].para).toBe("yimaproductos@gmail.com");
  });

  it("si falla el mail al cliente, igual manda el de YIMA", async () => {
    enviarMailMock.mockImplementation(async ({ para }) => {
      if (para === "juan@gmail.com") throw new Error("Invalid login");
    });

    await notificarOrdenCreada(ORDEN);

    expect(enviarMailMock).toHaveBeenCalledTimes(2);
  });

  it("nunca lanza, aunque fallen los dos envíos", async () => {
    enviarMailMock.mockRejectedValue(new Error("SMTP caído"));

    await expect(notificarOrdenCreada(ORDEN)).resolves.toBeUndefined();
  });

  it("registra cada fallo en ErrorLog", async () => {
    enviarMailMock.mockRejectedValue(new Error("SMTP caído"));

    await notificarOrdenCreada(ORDEN);

    expect(logErrorMock).toHaveBeenCalledTimes(2);
    expect(logErrorMock.mock.calls[0][0].mensaje).toContain("orden 42");
  });
});

describe("notificarCambioEstado", () => {
  it("reporta el envío exitoso", async () => {
    const resultado = await notificarCambioEstado({ ...ORDEN, estado: "CONFIRMADA" });

    expect(resultado).toEqual({ intentada: true, enviada: true });
    expect(enviarMailMock).toHaveBeenCalledTimes(1);
    expect(enviarMailMock.mock.calls[0][0].para).toBe("juan@gmail.com");
  });

  it("no intenta nada y explica el motivo cuando el cliente no tiene email", async () => {
    const sinEmail = { ...ORDEN, estado: "CONFIRMADA", cliente: { ...ORDEN.cliente, email: null } };

    const resultado = await notificarCambioEstado(sinEmail);

    expect(resultado).toEqual({
      intentada: false,
      enviada: false,
      error: "El cliente no tiene email registrado.",
    });
    expect(enviarMailMock).not.toHaveBeenCalled();
  });

  it("reporta el fallo en vez de lanzarlo", async () => {
    enviarMailMock.mockRejectedValue(new Error("Invalid login: 535-5.7.8"));

    const resultado = await notificarCambioEstado({ ...ORDEN, estado: "ENTREGADA" });

    expect(resultado.intentada).toBe(true);
    expect(resultado.enviada).toBe(false);
    expect(resultado.error).toContain("535");
  });

  it("registra el fallo en ErrorLog", async () => {
    enviarMailMock.mockRejectedValue(new Error("Invalid login"));

    await notificarCambioEstado({ ...ORDEN, estado: "ENTREGADA" });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });
});
