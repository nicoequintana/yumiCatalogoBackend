import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as plantillasEmail from "../lib/plantillasEmail.js";

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

  it("manda los mails de orden con categoria 'orden'", async () => {
    await notificarOrdenCreada(ORDEN);

    expect(enviarMailMock).toHaveBeenCalledWith(expect.objectContaining({ categoria: "orden" }));
  });

  it("registra cada fallo en ErrorLog", async () => {
    enviarMailMock.mockRejectedValue(new Error("SMTP caído"));

    await notificarOrdenCreada(ORDEN);

    expect(logErrorMock).toHaveBeenCalledTimes(2);
    expect(logErrorMock.mock.calls[0][0].mensaje).toContain("orden 42");
  });

  it("no lanza cuando la plantilla del cliente tira, y manda igual el mail a YIMA", async () => {
    const spy = vi
      .spyOn(plantillasEmail, "plantillaOrdenCreadaCliente")
      .mockImplementation(() => {
        throw new Error("plantilla rota");
      });

    try {
      await expect(notificarOrdenCreada(ORDEN)).resolves.toBeUndefined();

      expect(enviarMailMock).toHaveBeenCalledTimes(1);
      expect(enviarMailMock.mock.calls[0][0].para).toBe("yimaproductos@gmail.com");
      expect(logErrorMock).toHaveBeenCalledTimes(1);
      expect(logErrorMock.mock.calls[0][0].mensaje).toContain("orden 42");
    } finally {
      spy.mockRestore();
    }
  });

  it("no lanza cuando la plantilla del admin tira, y manda igual el mail al cliente", async () => {
    const spy = vi.spyOn(plantillasEmail, "plantillaOrdenCreadaAdmin").mockImplementation(() => {
      throw new Error("plantilla rota");
    });

    try {
      await expect(notificarOrdenCreada(ORDEN)).resolves.toBeUndefined();

      expect(enviarMailMock).toHaveBeenCalledTimes(1);
      expect(enviarMailMock.mock.calls[0][0].para).toBe("juan@gmail.com");
      expect(logErrorMock).toHaveBeenCalledTimes(1);
      expect(logErrorMock.mock.calls[0][0].mensaje).toContain("orden 42");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("notificarOrdenCreada — decisión 8, el contacto sale de la cuenta si hay una", () => {
  it("con cuentaCliente, el mail al comprador va a orden.cuentaCliente.email, no a orden.cliente.email", async () => {
    const conCuenta = {
      ...ORDEN,
      cliente: { ...ORDEN.cliente, email: "viejo@x.com", nombre: "Viejo" },
      cuentaCliente: { email: "nuevo@gmail.com", nombre: "Nuevo", telefono: "123" },
    };

    await notificarOrdenCreada(conCuenta);

    expect(enviarMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ para: "nuevo@gmail.com" }),
    );
    const destinos = enviarMailMock.mock.calls.map(([m]) => m.para);
    expect(destinos).not.toContain("viejo@x.com");
  });

  it("el saludo del comprador y el aviso interno llevan el nombre de la cuenta", async () => {
    const conCuenta = {
      ...ORDEN,
      cliente: { ...ORDEN.cliente, email: "viejo@x.com", nombre: "Viejo" },
      cuentaCliente: { email: "nuevo@gmail.com", nombre: "Nuevo", telefono: "123" },
    };

    await notificarOrdenCreada(conCuenta);

    const alCliente = enviarMailMock.mock.calls.find(([m]) => m.para === "nuevo@gmail.com")[0];
    const alAdmin = enviarMailMock.mock.calls.find(([m]) => m.para === "yimaproductos@gmail.com")[0];
    expect(alCliente.texto).toContain("Hola Nuevo");
    expect(alAdmin.texto).toContain("Nombre: Nuevo");
    // El DNI es identidad comercial: sale de `Cliente` aunque haya cuenta.
    expect(alAdmin.texto).toContain("DNI: 12345678");
  });

  it("sin cuentaCliente, sigue yendo a orden.cliente.email como siempre", async () => {
    await notificarOrdenCreada(ORDEN);

    expect(enviarMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ para: "juan@gmail.com" }),
    );
  });

  // `contactoDeOrden` tolera una orden falsy y devuelve los tres campos en
  // `null`. Esto es fire-and-forget: un throw acá se perdería sin rastro.
  it("no lanza ni manda mail al comprador cuando la orden no tiene ni cuenta ni cliente", async () => {
    const huerfana = { id: 7, estado: "PENDIENTE", notas: null, items: ORDEN.items };

    await expect(notificarOrdenCreada(huerfana)).resolves.toBeUndefined();

    expect(enviarMailMock).toHaveBeenCalledTimes(1);
    expect(enviarMailMock.mock.calls[0][0].para).toBe("yimaproductos@gmail.com");
  });
});

describe("notificarCambioEstado — mismo criterio", () => {
  it("con cuentaCliente, notifica al email de la cuenta", async () => {
    const conCuenta = {
      ...ORDEN,
      estado: "ENTREGADA",
      cliente: { ...ORDEN.cliente, email: "viejo@x.com", nombre: "Viejo" },
      cuentaCliente: { email: "nuevo@gmail.com", nombre: "Nuevo" },
    };

    const resultado = await notificarCambioEstado(conCuenta);

    expect(resultado.intentada).toBe(true);
    expect(enviarMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ para: "nuevo@gmail.com" }),
    );
  });

  // La preferencia es de OBJETO COMPLETO: con cuenta, el email sale de la
  // cuenta o no sale. Mezclarlo con el de `Cliente` mandaría "Hola Nuevo" a la
  // casilla de otro dueño del mismo DNI.
  it("una cuenta sin email NO cae al de Cliente: no se intenta el aviso", async () => {
    const conCuenta = {
      ...ORDEN,
      estado: "ENTREGADA",
      cuentaCliente: { email: null, nombre: "Nuevo", telefono: null },
    };

    const resultado = await notificarCambioEstado(conCuenta);

    expect(resultado.intentada).toBe(false);
    expect(enviarMailMock).not.toHaveBeenCalled();
  });
});

describe("notificarCambioEstado", () => {
  it("reporta el envío exitoso", async () => {
    const resultado = await notificarCambioEstado({ ...ORDEN, estado: "EN_PREPARACION" });

    expect(resultado).toEqual({ intentada: true, enviada: true });
    expect(enviarMailMock).toHaveBeenCalledTimes(1);
    expect(enviarMailMock.mock.calls[0][0].para).toBe("juan@gmail.com");
  });

  it("no intenta nada y explica el motivo cuando el cliente no tiene email", async () => {
    const sinEmail = { ...ORDEN, estado: "EN_PREPARACION", cliente: { ...ORDEN.cliente, email: null } };

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

  it("un mail DESCARTADO por presupuesto no se reporta como enviado", async () => {
    enviarMailMock.mockResolvedValue({ descartado: true });

    const resultado = await notificarCambioEstado({ ...ORDEN, estado: "ENTREGADA" });

    expect(resultado.intentada).toBe(true);
    expect(resultado.enviada).toBe(false);
    expect(resultado.error).toMatch(/tope|presupuesto/i);
  });

  it("registra el fallo en ErrorLog", async () => {
    enviarMailMock.mockRejectedValue(new Error("Invalid login"));

    await notificarCambioEstado({ ...ORDEN, estado: "ENTREGADA" });

    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });

  it("reporta el fallo en vez de lanzar cuando la plantilla tira", async () => {
    const spy = vi
      .spyOn(plantillasEmail, "plantillaCambioEstadoCliente")
      .mockImplementation(() => {
        throw new Error("plantilla rota");
      });

    try {
      const resultado = await notificarCambioEstado({ ...ORDEN, estado: "ENTREGADA" });

      expect(resultado.intentada).toBe(true);
      expect(resultado.enviada).toBe(false);
      expect(resultado.error).toContain("plantilla rota");
      expect(enviarMailMock).not.toHaveBeenCalled();
      expect(logErrorMock).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
