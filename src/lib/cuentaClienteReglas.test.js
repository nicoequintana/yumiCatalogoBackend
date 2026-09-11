import { describe, expect, it, vi } from "vitest";

vi.mock("./prisma.js", () => ({ prisma: {} }));

const { MS_PURGA_NO_VERIFICADAS, purgarVencidaConEmail } = await import("./cuentaClienteReglas.js");

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
