import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
const logErrorMock = vi.fn();

vi.mock("nodemailer", () => ({
  default: { createTransport: (...args) => createTransportMock(...args) },
}));

vi.mock("../lib/logError.js", () => ({
  logError: (...args) => logErrorMock(...args),
}));

const { enviarMail, resetearTransporter, _reiniciarPresupuestoParaTests } = await import(
  "./email.service.js"
);

const ENTORNO_ORIGINAL = { ...process.env };

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: "<abc@gmail.com>" });
  createTransportMock.mockClear();
  logErrorMock.mockReset();
  resetearTransporter();
  _reiniciarPresupuestoParaTests();
  process.env.SMTP_USER = "yimaproductos@gmail.com";
  process.env.SMTP_PASSWORD = "abcdefghijklmnop";
});

afterEach(() => {
  process.env = { ...ENTORNO_ORIGINAL };
});

describe("enviarMail", () => {
  it("se conecta a Gmail por el puerto seguro", async () => {
    await enviarMail({ para: "cliente@gmail.com", asunto: "Hola", texto: "t", html: "<p>t</p>" });

    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: "yimaproductos@gmail.com", pass: "abcdefghijklmnop" },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 12_000,
    });
  });

  it("manda el mail con el remitente rotulado como YIMA", async () => {
    await enviarMail({ para: "cliente@gmail.com", asunto: "Hola", texto: "t", html: "<p>t</p>" });

    expect(sendMailMock).toHaveBeenCalledWith({
      from: "YIMA <yimaproductos@gmail.com>",
      to: "cliente@gmail.com",
      subject: "Hola",
      text: "t",
      html: "<p>t</p>",
    });
  });

  it("construye el transporter una sola vez aunque se mande varias veces", async () => {
    await enviarMail({ para: "a@b.com", asunto: "1", texto: "t", html: "<p>t</p>" });
    await enviarMail({ para: "c@d.com", asunto: "2", texto: "t", html: "<p>t</p>" });

    expect(createTransportMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it("no construye el transporter al importar el módulo, solo al primer envío", () => {
    // El beforeEach ya reseteó; sin ninguna llamada a enviarMail no hubo transporter.
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it("lanza si faltan las credenciales", async () => {
    delete process.env.SMTP_PASSWORD;
    resetearTransporter();

    await expect(
      enviarMail({ para: "a@b.com", asunto: "x", texto: "t", html: "<p>t</p>" }),
    ).rejects.toThrow(/SMTP_USER y SMTP_PASSWORD/);
  });

  it("propaga el error del transporte", async () => {
    sendMailMock.mockRejectedValue(new Error("Invalid login: 535-5.7.8"));

    await expect(
      enviarMail({ para: "a@b.com", asunto: "x", texto: "t", html: "<p>t</p>" }),
    ).rejects.toThrow("Invalid login: 535-5.7.8");
  });
});

describe("presupuesto por hora", () => {
  it("cada categoría tiene su propio contador: agotar 'resto' no toca 'acceso' ni 'orden'", async () => {
    process.env.PRESUPUESTO_MAIL_RESTO_HORA = "2";
    for (let i = 0; i < 2; i++) {
      await enviarMail({ para: `r${i}@x.com`, asunto: "r", texto: "t", html: "<p>t</p>", categoria: "resto" });
    }
    sendMailMock.mockClear();

    // El tercer "resto" se descarta en silencio: no lanza, no manda.
    await enviarMail({ para: "r3@x.com", asunto: "r", texto: "t", html: "<p>t</p>", categoria: "resto" });
    expect(sendMailMock).not.toHaveBeenCalled();

    // Amenaza 10: un "acceso" sale IGUAL, con 'resto' agotado.
    await enviarMail({ para: "acceso@x.com", asunto: "a", texto: "t", html: "<p>t</p>", categoria: "acceso" });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "acceso@x.com" }));
  });

  it("con el default (200/60/100), 'resto' avisa una sola vez por hora al tope, no en cada envío descartado", async () => {
    process.env.PRESUPUESTO_MAIL_RESTO_HORA = "1";
    await enviarMail({ para: "a@x.com", asunto: "a", texto: "t", html: "<p>t</p>", categoria: "resto" });
    await enviarMail({ para: "b@x.com", asunto: "b", texto: "t", html: "<p>t</p>", categoria: "resto" });
    await enviarMail({ para: "c@x.com", asunto: "c", texto: "t", html: "<p>t</p>", categoria: "resto" });
    expect(logErrorMock).toHaveBeenCalledTimes(1);
  });

  it("'acceso' al agotarse ENCOLA (no lanza) y drena en el próximo envío con lugar", async () => {
    process.env.PRESUPUESTO_MAIL_ACCESO_HORA = "1";
    await enviarMail({ para: "primero@x.com", asunto: "1", texto: "t", html: "<p>t</p>", categoria: "acceso" });
    sendMailMock.mockClear();

    // Segundo agotó el cupo: se encola, no lanza.
    await expect(
      enviarMail({ para: "segundo@x.com", asunto: "2", texto: "t", html: "<p>t</p>", categoria: "acceso" }),
    ).resolves.toBeUndefined();
    expect(sendMailMock).not.toHaveBeenCalled();

    // Sube el cupo y dispara CUALQUIER envío: el drenado corre antes de procesar el nuevo.
    process.env.PRESUPUESTO_MAIL_ACCESO_HORA = "10";
    await enviarMail({ para: "tercero@x.com", asunto: "3", texto: "t", html: "<p>t</p>", categoria: "acceso" });
    const destinos = sendMailMock.mock.calls.map((c) => c[0].to);
    expect(destinos).toEqual(expect.arrayContaining(["segundo@x.com", "tercero@x.com"]));
  });

  it("un contador vuelve a 0 al pasar la hora", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      process.env.PRESUPUESTO_MAIL_RESTO_HORA = "1";
      await enviarMail({ para: "a@x.com", asunto: "a", texto: "t", html: "<p>t</p>", categoria: "resto" });
      sendMailMock.mockClear();
      await enviarMail({ para: "b@x.com", asunto: "b", texto: "t", html: "<p>t</p>", categoria: "resto" });
      expect(sendMailMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(61 * 60 * 1000);
      await enviarMail({ para: "c@x.com", asunto: "c", texto: "t", html: "<p>t</p>", categoria: "resto" });
      expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "c@x.com" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("con la env inválida cae al default de la categoría", async () => {
    process.env.PRESUPUESTO_MAIL_ORDEN_HORA = "no-es-un-numero";
    // Un solo envío no puede tocar el default (200): si la env rota tirara el
    // tope a 0, este envío ya se descartaría.
    await enviarMail({ para: "o@x.com", asunto: "o", texto: "t", html: "<p>t</p>", categoria: "orden" });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});
