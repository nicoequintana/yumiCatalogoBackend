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
    ).resolves.toEqual({ descartado: false, encolado: true });
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

  it("un envío que sale resuelve { descartado: false }", async () => {
    await expect(
      enviarMail({ para: "a@x.com", asunto: "a", texto: "t", html: "<p>t</p>", categoria: "orden" }),
    ).resolves.toEqual({ descartado: false });
  });

  it("'orden' y 'resto' sobre el tope resuelven { descartado: true } — el llamador tiene que poder distinguirlo", async () => {
    process.env.PRESUPUESTO_MAIL_ORDEN_HORA = "1";
    await enviarMail({ para: "a@x.com", asunto: "a", texto: "t", html: "<p>t</p>", categoria: "orden" });
    await expect(
      enviarMail({ para: "b@x.com", asunto: "b", texto: "t", html: "<p>t</p>", categoria: "orden" }),
    ).resolves.toEqual({ descartado: true });
  });

  it("una categoría desconocida cae en 'resto' en vez de reventar con TypeError", async () => {
    process.env.PRESUPUESTO_MAIL_RESTO_HORA = "1";
    await expect(
      enviarMail({ para: "a@x.com", asunto: "a", texto: "t", html: "<p>t</p>", categoria: "inventada" }),
    ).resolves.toEqual({ descartado: false });
    // Comparte el contador de 'resto': el segundo ya se descarta.
    await expect(
      enviarMail({ para: "b@x.com", asunto: "b", texto: "t", html: "<p>t</p>", categoria: "resto" }),
    ).resolves.toEqual({ descartado: true });
  });

  it("con la env inválida cae al default de la categoría", async () => {
    process.env.PRESUPUESTO_MAIL_ORDEN_HORA = "no-es-un-numero";
    // Un solo envío no puede tocar el default (200): si la env rota tirara el
    // tope a 0, este envío ya se descartaría.
    await enviarMail({ para: "o@x.com", asunto: "o", texto: "t", html: "<p>t</p>", categoria: "orden" });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

const MINUTO = 60 * 1000;

/** Agota el cupo por hora de 'acceso' (1) y deja `destinos` en la cola. */
async function encolarAcceso(destinos, { expiraEn } = {}) {
  process.env.PRESUPUESTO_MAIL_ACCESO_HORA = "1";
  await enviarMail({ para: "cupo@x.com", asunto: "c", texto: "t", html: "<p>t</p>", categoria: "acceso" });
  for (const para of destinos) {
    await enviarMail({ para, asunto: "a", texto: "t", html: "<p>t</p>", categoria: "acceso", expiraEn });
  }
  sendMailMock.mockClear();
}

describe("cola de 'acceso'", () => {
  it("un mail encolado cuyo código ya venció (o está por vencer) se descarta: no se manda tarde", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // CODIGO_ACCESO vive 10 min; la cola retiene hasta 1 h.
      await encolarAcceso(["vencido@x.com"], { expiraEn: new Date(Date.now() + 10 * MINUTO) });
      // 11 min: dentro del TTL de la cola (1 h), fuera de la vida del código.
      vi.advanceTimersByTime(11 * MINUTO);
      process.env.PRESUPUESTO_MAIL_ACCESO_HORA = "10";

      await enviarMail({ para: "otro@x.com", asunto: "o", texto: "t", html: "<p>t</p>", categoria: "orden" });

      const destinos = sendMailMock.mock.calls.map((c) => c[0].to);
      expect(destinos).not.toContain("vencido@x.com");
      expect(destinos).toContain("otro@x.com");
    } finally {
      vi.useRealTimers();
    }
  });

  it("el margen: a 30 s de vencer tampoco se manda (llegaría vencido)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await encolarAcceso(["justo@x.com"], { expiraEn: new Date(Date.now() + 61 * MINUTO + 30_000) });
      vi.advanceTimersByTime(61 * MINUTO);
      process.env.PRESUPUESTO_MAIL_ACCESO_HORA = "10";

      await enviarMail({ para: "otro@x.com", asunto: "o", texto: "t", html: "<p>t</p>", categoria: "orden" });

      expect(sendMailMock.mock.calls.map((c) => c[0].to)).not.toContain("justo@x.com");
    } finally {
      vi.useRealTimers();
    }
  });

  it("un encolado todavía vigente SÍ se drena", async () => {
    await encolarAcceso(["vigente@x.com"], { expiraEn: new Date(Date.now() + 10 * MINUTO) });
    process.env.PRESUPUESTO_MAIL_ACCESO_HORA = "10";

    await enviarMail({ para: "otro@x.com", asunto: "o", texto: "t", html: "<p>t</p>", categoria: "orden" });

    await vi.waitFor(() => {
      expect(sendMailMock.mock.calls.map((c) => c[0].to)).toContain("vigente@x.com");
    });
  });

  it("el drenado NO bloquea el envío en curso: un mail de orden sale aunque la cola esté colgada en Gmail", async () => {
    await encolarAcceso(["colgado@x.com"]);
    process.env.PRESUPUESTO_MAIL_ACCESO_HORA = "10";
    sendMailMock.mockImplementation((m) =>
      m.to === "colgado@x.com" ? new Promise(() => {}) : Promise.resolve({ messageId: "x" }),
    );

    const resultado = await Promise.race([
      enviarMail({ para: "orden@x.com", asunto: "o", texto: "t", html: "<p>t</p>", categoria: "orden" }),
      new Promise((resolver) => setTimeout(() => resolver("colgado"), 200)),
    ]);

    expect(resultado).toEqual({ descartado: false });
    expect(sendMailMock.mock.calls.map((c) => c[0].to)).toContain("orden@x.com");
  });

  it("un solo drenado a la vez: mientras uno está en vuelo, otro envío no arranca un segundo", async () => {
    await encolarAcceso(["colgado@x.com", "segundo@x.com"]);
    process.env.PRESUPUESTO_MAIL_ACCESO_HORA = "10";
    sendMailMock.mockImplementation((m) =>
      m.to === "colgado@x.com" ? new Promise(() => {}) : Promise.resolve({ messageId: "x" }),
    );

    await enviarMail({ para: "o1@x.com", asunto: "o", texto: "t", html: "<p>t</p>", categoria: "orden" });
    await enviarMail({ para: "o2@x.com", asunto: "o", texto: "t", html: "<p>t</p>", categoria: "orden" });

    // Un segundo drenado concurrente habría sacado a "segundo" de la cola y
    // lo habría mandado en paralelo, fuera de orden.
    expect(sendMailMock.mock.calls.map((c) => c[0].to)).not.toContain("segundo@x.com");
  });

  it("la cola tiene tope: al superarlo se descarta el MÁS VIEJO y se avisa una sola vez", async () => {
    const destinos = Array.from({ length: 202 }, (_, i) => `d${i}@x.com`);
    await encolarAcceso(destinos);
    logErrorMock.mockClear();
    await enviarMail({ para: "d202@x.com", asunto: "a", texto: "t", html: "<p>t</p>", categoria: "acceso" });
    expect(logErrorMock).not.toHaveBeenCalled(); // el aviso de cola llena ya salió antes, una vez

    process.env.PRESUPUESTO_MAIL_ACCESO_HORA = "1000";
    process.env.PRESUPUESTO_MAIL_ACCESO_DIA = "1000";
    await enviarMail({ para: "otro@x.com", asunto: "o", texto: "t", html: "<p>t</p>", categoria: "orden" });

    await vi.waitFor(() => {
      expect(sendMailMock.mock.calls.map((c) => c[0].to)).toContain("d202@x.com");
    });
    const drenados = sendMailMock.mock.calls.map((c) => c[0].to).filter((d) => d !== "otro@x.com");
    expect(drenados).toHaveLength(200);
    expect(drenados).not.toContain("d0@x.com");
    expect(drenados).not.toContain("d2@x.com");
    expect(drenados[0]).toBe("d3@x.com");
  });

  it("la cola llena avisa por logError una sola vez aunque siga desbordando", async () => {
    const destinos = Array.from({ length: 205 }, (_, i) => `d${i}@x.com`);
    process.env.PRESUPUESTO_MAIL_ACCESO_HORA = "1";
    await enviarMail({ para: "cupo@x.com", asunto: "c", texto: "t", html: "<p>t</p>", categoria: "acceso" });
    logErrorMock.mockClear();
    for (const para of destinos) {
      await enviarMail({ para, asunto: "a", texto: "t", html: "<p>t</p>", categoria: "acceso" });
    }
    const avisosCola = logErrorMock.mock.calls.filter(([e]) => /cola/i.test(e.mensaje));
    expect(avisosCola).toHaveLength(1);
  });
});

describe("presupuesto por día (techo declarado de la spec: 300 envíos/día)", () => {
  it("con los defaults, 'resto' se corta en su tope diario (60) aunque le quede cupo por hora (100)", async () => {
    for (let i = 0; i < 60; i++) {
      await enviarMail({ para: `r${i}@x.com`, asunto: "r", texto: "t", html: "<p>t</p>", categoria: "resto" });
    }
    sendMailMock.mockClear();
    await expect(
      enviarMail({ para: "r60@x.com", asunto: "r", texto: "t", html: "<p>t</p>", categoria: "resto" }),
    ).resolves.toEqual({ descartado: true });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("el tope diario NO se reinicia al pasar la hora, sí al pasar el día", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      process.env.PRESUPUESTO_MAIL_ORDEN_DIA = "2";
      await enviarMail({ para: "a@x.com", asunto: "a", texto: "t", html: "<p>t</p>", categoria: "orden" });
      await enviarMail({ para: "b@x.com", asunto: "b", texto: "t", html: "<p>t</p>", categoria: "orden" });

      vi.advanceTimersByTime(61 * MINUTO);
      await expect(
        enviarMail({ para: "c@x.com", asunto: "c", texto: "t", html: "<p>t</p>", categoria: "orden" }),
      ).resolves.toEqual({ descartado: true });

      vi.advanceTimersByTime(24 * 60 * MINUTO);
      await expect(
        enviarMail({ para: "d@x.com", asunto: "d", texto: "t", html: "<p>t</p>", categoria: "orden" }),
      ).resolves.toEqual({ descartado: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("'acceso' sobre el tope diario ENCOLA igual que sobre el horario", async () => {
    process.env.PRESUPUESTO_MAIL_ACCESO_DIA = "1";
    await enviarMail({ para: "a@x.com", asunto: "a", texto: "t", html: "<p>t</p>", categoria: "acceso" });
    await expect(
      enviarMail({ para: "b@x.com", asunto: "b", texto: "t", html: "<p>t</p>", categoria: "acceso" }),
    ).resolves.toEqual({ descartado: false, encolado: true });
  });

  it("el tope diario avisa una sola vez por día, no en cada descarte", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      process.env.PRESUPUESTO_MAIL_RESTO_DIA = "1";
      await enviarMail({ para: "a@x.com", asunto: "a", texto: "t", html: "<p>t</p>", categoria: "resto" });
      await enviarMail({ para: "b@x.com", asunto: "b", texto: "t", html: "<p>t</p>", categoria: "resto" });
      vi.advanceTimersByTime(61 * MINUTO); // nueva hora, mismo día
      await enviarMail({ para: "c@x.com", asunto: "c", texto: "t", html: "<p>t</p>", categoria: "resto" });
      expect(logErrorMock).toHaveBeenCalledTimes(1);
      expect(logErrorMock.mock.calls[0][0].mensaje).toMatch(/día/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("con la env diaria inválida cae al default de la categoría", async () => {
    process.env.PRESUPUESTO_MAIL_ORDEN_DIA = "-3";
    await expect(
      enviarMail({ para: "o@x.com", asunto: "o", texto: "t", html: "<p>t</p>", categoria: "orden" }),
    ).resolves.toEqual({ descartado: false });
  });
});
