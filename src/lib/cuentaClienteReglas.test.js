import { describe, expect, it, vi } from "vitest";

vi.mock("./prisma.js", () => ({ prisma: {} }));

const { MS_PURGA_NO_VERIFICADAS, purgarVencidaConEmail, textoOpcionalAcotado } = await import("./cuentaClienteReglas.js");

describe("textoOpcionalAcotado", () => {
  it("vacío, solo espacios, null o undefined: devuelve null (así el apodo se puede BORRAR)", () => {
    expect(textoOpcionalAcotado("", { etiqueta: "El apodo" })).toBeNull();
    expect(textoOpcionalAcotado("   ", { etiqueta: "El apodo" })).toBeNull();
    expect(textoOpcionalAcotado(null, { etiqueta: "El apodo" })).toBeNull();
    expect(textoOpcionalAcotado(undefined, { etiqueta: "El apodo" })).toBeNull();
  });

  it("texto normal: devuelve el trim", () => {
    expect(textoOpcionalAcotado("  Nico  ", { etiqueta: "El apodo" })).toBe("Nico");
  });

  it("más largo que LARGO_MAX_TEXTO: 400 con el mismo formato que exigirTextoAcotado", () => {
    expect(() => textoOpcionalAcotado("a".repeat(1001), { etiqueta: "El apodo" })).toThrowError(
      expect.objectContaining({ status: 400, message: "El apodo no puede superar los 1000 caracteres." }),
    );
  });
});

describe("purgarVencidaConEmail", () => {
  it("borra SOLO la fila nunca verificada, vencida y sin pedidos que tiene ese email, por el cliente que recibe", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const antes = Date.now();

    await purgarVencidaConEmail({ cuentaCliente: { deleteMany } }, "nuevo@gmail.com");

    const { where } = deleteMany.mock.calls[0][0];
    expect(where).toEqual({
      email: "nuevo@gmail.com",
      emailVerificado: false,
      verificadaEn: null,
      createdAt: { lt: expect.any(Date) },
      ordenes: { none: {} },
    });
    const corte = antes - where.createdAt.lt.getTime();
    expect(corte).toBeGreaterThanOrEqual(MS_PURGA_NO_VERIFICADAS - 50);
    expect(corte).toBeLessThan(MS_PURGA_NO_VERIFICADAS + 5000);
  });
});
