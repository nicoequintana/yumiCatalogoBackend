import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const createMock = vi.fn();
const updateManyMock = vi.fn();
const findUniqueMock = vi.fn();
const deleteManyMock = vi.fn();

vi.mock("./prisma.js", () => ({
  prisma: {
    tokenCuenta: {
      create: (...args) => createMock(...args),
      updateMany: (...args) => updateManyMock(...args),
      findUnique: (...args) => findUniqueMock(...args),
      deleteMany: (...args) => deleteManyMock(...args),
    },
  },
}));

const {
  consumirCodigoAcceso,
  consumirToken,
  emitirCodigoAcceso,
  emitirToken,
  hashDeCodigo,
  hashDeToken,
  invalidarTokensDe,
} = await import("./tokensCuenta.js");

function sha256(texto) {
  return createHash("sha256").update(texto).digest("hex");
}

beforeEach(() => {
  createMock.mockReset();
  updateManyMock.mockReset();
  findUniqueMock.mockReset();
  deleteManyMock.mockReset();
  createMock.mockResolvedValue({});
  deleteManyMock.mockResolvedValue({ count: 0 });
});

describe("hashDeToken / hashDeCodigo", () => {
  it("hashDeToken es SHA-256 hex del token en claro", () => {
    expect(hashDeToken("abc")).toBe(sha256("abc"));
    expect(hashDeToken("abc")).toHaveLength(64);
  });

  it("hashDeCodigo incluye el id de cuenta: el mismo codigo en dos cuentas da hashes distintos", () => {
    expect(hashDeCodigo(1, "123456")).toBe(sha256("1:123456"));
    expect(hashDeCodigo(1, "123456")).not.toBe(hashDeCodigo(2, "123456"));
  });
});

describe("emitirToken", () => {
  it("guarda SOLO el hash, con el tipo y la expiracion del tipo, y devuelve el claro", async () => {
    const antes = Date.now();
    const { tokenClaro, expiraEn } = await emitirToken({ cuentaClienteId: 7, tipo: "RESET" });

    expect(tokenClaro).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const data = createMock.mock.calls[0][0].data;
    expect(data.tokenHash).toBe(sha256(tokenClaro));
    expect(data.tipo).toBe("RESET");
    expect(data.cuentaClienteId).toBe(7);
    expect(data.emailNuevo).toBeNull();
    expect(expiraEn.getTime() - antes).toBeGreaterThanOrEqual(60 * 60 * 1000 - 50);
    expect(expiraEn.getTime() - antes).toBeLessThan(60 * 60 * 1000 + 5000);
    expect(JSON.stringify(data)).not.toContain(tokenClaro);
  });

  it("CAMBIO_EMAIL guarda emailNuevo", async () => {
    await emitirToken({ cuentaClienteId: 7, tipo: "CAMBIO_EMAIL", emailNuevo: "nuevo@gmail.com" });
    expect(createMock.mock.calls[0][0].data.emailNuevo).toBe("nuevo@gmail.com");
  });

  it("rechaza un tipo que no esta en la lista cerrada", async () => {
    await expect(emitirToken({ cuentaClienteId: 7, tipo: "LOGIN" })).rejects.toThrow(/tipo/i);
  });

  it("limpia oportunisticamente los vencidos hace mas de 30 dias", async () => {
    await emitirToken({ cuentaClienteId: 7, tipo: "RESET" });
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
    const where = deleteManyMock.mock.calls[0][0].where;
    expect(where.expiraEn.lt).toBeInstanceOf(Date);
    expect(Date.now() - where.expiraEn.lt.getTime()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  });
});

describe("consumirToken — escritura guardada", () => {
  it("consume con updateMany cuyo where lleva tokenHash, tipo, usadoEn null y expiraEn > now, y recien despues lee la fila", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });
    findUniqueMock.mockResolvedValue({ id: 3, cuentaClienteId: 7, tipo: "RESET", emailNuevo: null });

    const resultado = await consumirToken({ tokenClaro: "abc", tipo: "RESET" });

    expect(resultado).toEqual({ ok: true, fila: { id: 3, cuentaClienteId: 7, tipo: "RESET", emailNuevo: null } });
    const { where, data } = updateManyMock.mock.calls[0][0];
    expect(where.tokenHash).toBe(sha256("abc"));
    expect(where.tipo).toBe("RESET");
    expect(where.usadoEn).toBeNull();
    expect(where.expiraEn.gt).toBeInstanceOf(Date);
    expect(data.usadoEn).toBeInstanceOf(Date);
    // La lectura va DESPUES de la escritura, nunca antes.
    expect(updateManyMock.mock.invocationCallOrder[0]).toBeLessThan(findUniqueMock.mock.invocationCallOrder[0]);
  });

  it("un VERIFICACION no sirve como RESET: el tipo va en el where", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValue({ id: 3, tipo: "VERIFICACION", usadoEn: null, expiraEn: new Date(Date.now() + 1000) });

    const resultado = await consumirToken({ tokenClaro: "abc", tipo: "RESET" });

    expect(resultado.ok).toBe(false);
    expect(updateManyMock.mock.calls[0][0].where.tipo).toBe("RESET");
  });

  it("distingue USADO de VENCIDO de INVALIDO con una lectura posterior, sin escribir", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });

    findUniqueMock.mockResolvedValueOnce({ tipo: "RESET", usadoEn: new Date(), expiraEn: new Date(Date.now() + 1000) });
    expect(await consumirToken({ tokenClaro: "a", tipo: "RESET" })).toEqual({ ok: false, motivo: "USADO" });

    findUniqueMock.mockResolvedValueOnce({ tipo: "RESET", usadoEn: null, expiraEn: new Date(Date.now() - 1000) });
    expect(await consumirToken({ tokenClaro: "b", tipo: "RESET" })).toEqual({ ok: false, motivo: "VENCIDO" });

    findUniqueMock.mockResolvedValueOnce(null);
    expect(await consumirToken({ tokenClaro: "c", tipo: "RESET" })).toEqual({ ok: false, motivo: "INVALIDO" });

    // Tres consumos fallidos: tres updateMany, cero escrituras adicionales.
    expect(updateManyMock).toHaveBeenCalledTimes(3);
  });

  it("un token de otro tipo que existe se reporta INVALIDO, no USADO ni VENCIDO", async () => {
    updateManyMock.mockResolvedValue({ count: 0 });
    findUniqueMock.mockResolvedValueOnce({ tipo: "VERIFICACION", usadoEn: null, expiraEn: new Date(Date.now() + 1000) });
    expect(await consumirToken({ tokenClaro: "a", tipo: "RESET" })).toEqual({ ok: false, motivo: "INVALIDO" });
  });

  it("un token en claro vacio o no string es INVALIDO sin tocar la base", async () => {
    expect(await consumirToken({ tokenClaro: "", tipo: "RESET" })).toEqual({ ok: false, motivo: "INVALIDO" });
    expect(await consumirToken({ tokenClaro: 42, tipo: "RESET" })).toEqual({ ok: false, motivo: "INVALIDO" });
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

describe("codigo de acceso", () => {
  it("emitirCodigoAcceso genera seis digitos, invalida los anteriores y guarda el hash con el id de cuenta", async () => {
    updateManyMock.mockResolvedValue({ count: 1 });
    const { codigo } = await emitirCodigoAcceso(7);

    expect(codigo).toMatch(/^\d{6}$/);
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { cuentaClienteId: 7, tipo: "CODIGO_ACCESO", usadoEn: null },
    });
    expect(createMock.mock.calls[0][0].data.tokenHash).toBe(sha256(`7:${codigo}`));
    expect(createMock.mock.calls[0][0].data.tipo).toBe("CODIGO_ACCESO");
  });

  it("consumirCodigoAcceso cuenta el intento ANTES de comparar: el where exige intentos < 5", async () => {
    // Primer updateMany: el incremento del intento sobre el codigo vigente de la cuenta.
    updateManyMock.mockResolvedValueOnce({ count: 1 });
    // Segundo updateMany: el consumo guardado por hash.
    updateManyMock.mockResolvedValueOnce({ count: 1 });

    const resultado = await consumirCodigoAcceso({ cuentaClienteId: 7, codigo: "123456" });

    expect(resultado).toEqual({ ok: true });
    const incremento = updateManyMock.mock.calls[0][0];
    expect(incremento.where).toMatchObject({ cuentaClienteId: 7, tipo: "CODIGO_ACCESO", usadoEn: null, intentos: { lt: 5 } });
    expect(incremento.data).toEqual({ intentos: { increment: 1 } });
    const consumo = updateManyMock.mock.calls[1][0];
    expect(consumo.where.tokenHash).toBe(sha256("7:123456"));
    expect(consumo.where.tipo).toBe("CODIGO_ACCESO");
  });

  it("con los intentos agotados no compara nada", async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 });
    expect(await consumirCodigoAcceso({ cuentaClienteId: 7, codigo: "123456" })).toEqual({ ok: false });
    expect(updateManyMock).toHaveBeenCalledTimes(1);
  });

  it("un codigo que no son seis digitos es rechazado sin tocar la base", async () => {
    expect(await consumirCodigoAcceso({ cuentaClienteId: 7, codigo: "12345" })).toEqual({ ok: false });
    expect(await consumirCodigoAcceso({ cuentaClienteId: 7, codigo: "abcdef" })).toEqual({ ok: false });
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});

describe("invalidarTokensDe", () => {
  it("marca como usados todos los tokens vivos de ese tipo de esa cuenta", async () => {
    updateManyMock.mockResolvedValue({ count: 2 });
    await invalidarTokensDe(7, "RESET");
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { cuentaClienteId: 7, tipo: "RESET", usadoEn: null },
    });
    expect(updateManyMock.mock.calls[0][0].data.usadoEn).toBeInstanceOf(Date);
  });
});
