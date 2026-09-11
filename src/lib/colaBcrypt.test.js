import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("colaBcrypt", () => {
  let cola;

  beforeEach(async () => {
    process.env.BCRYPT_CONCURRENCIA = "2";
    cola = await import("./colaBcrypt.js");
    cola._reiniciarParaTests();
  });

  afterEach(() => {
    delete process.env.BCRYPT_CONCURRENCIA;
  });

  it("entrega slots hasta la concurrencia configurada", async () => {
    const liberar1 = await cola.reservarSlot();
    const liberar2 = await cola.reservarSlot();
    expect(typeof liberar1).toBe("function");
    expect(typeof liberar2).toBe("function");
    liberar1();
    liberar2();
  });

  it("el tercero recibe 503 CAPACIDAD con Retry-After, ANTES de hacer nada", async () => {
    const liberar1 = await cola.reservarSlot();
    const liberar2 = await cola.reservarSlot();

    await expect(cola.reservarSlot()).rejects.toMatchObject({
      status: 503,
      codigo: "CAPACIDAD",
      retryAfter: 2,
    });

    liberar1();
    liberar2();
  });

  it("liberar un slot vuelve a dejar entrar", async () => {
    const liberar1 = await cola.reservarSlot();
    const liberar2 = await cola.reservarSlot();
    liberar1();
    const liberar3 = await cola.reservarSlot();
    expect(typeof liberar3).toBe("function");
    liberar2();
    liberar3();
  });

  it("liberar dos veces el mismo slot no regala capacidad", async () => {
    const liberar1 = await cola.reservarSlot();
    const liberar2 = await cola.reservarSlot();
    liberar1();
    liberar1();
    const liberar3 = await cola.reservarSlot();
    await expect(cola.reservarSlot()).rejects.toMatchObject({ codigo: "CAPACIDAD" });
    liberar2();
    liberar3();
  });

  it("estaBajoPresion es true con la mitad o mas de los slots tomados", async () => {
    expect(cola.estaBajoPresion()).toBe(false);
    const liberar1 = await cola.reservarSlot();
    expect(cola.estaBajoPresion()).toBe(true);
    liberar1();
    expect(cola.estaBajoPresion()).toBe(false);
  });

  it("con BCRYPT_CONCURRENCIA invalida usa 3", async () => {
    process.env.BCRYPT_CONCURRENCIA = "cero";
    cola._reiniciarParaTests();
    const libs = [await cola.reservarSlot(), await cola.reservarSlot(), await cola.reservarSlot()];
    await expect(cola.reservarSlot()).rejects.toMatchObject({ codigo: "CAPACIDAD" });
    libs.forEach((l) => l());
  });
});
