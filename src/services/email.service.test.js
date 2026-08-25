import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: (...args) => createTransportMock(...args) },
}));

const { enviarMail, resetearTransporter } = await import("./email.service.js");

const ENTORNO_ORIGINAL = { ...process.env };

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: "<abc@gmail.com>" });
  createTransportMock.mockClear();
  resetearTransporter();
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
