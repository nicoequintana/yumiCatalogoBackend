import { describe, expect, it, vi } from "vitest";
import { exigirIdsExistentes } from "./idsExistentes.js";

/**
 * Guard del chequeo "estos ids ya no existen".
 *
 * El bloque vivía copiado en dos controllers (`campanias` para promociones,
 * `promociones` para productos). Lo que se prueba acá no es la consulta —eso lo
 * hace Prisma— sino las tres decisiones que la copia repetía: no consultar de
 * más, nombrar al que falta, y devolver un 400 y no un 500.
 */

function delegateQueDevuelve(ids) {
  return { findMany: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))) };
}

describe("exigirIdsExistentes", () => {
  it("con la lista vacía NO consulta la base", async () => {
    // Un `in: []` es una consulta garantizada a devolver cero filas: pagarle un
    // round-trip a la base para confirmar la nada es puro desperdicio, y en
    // `PUT /:id/productos` el caso vacío ("desasociar todo") es frecuente.
    const delegate = delegateQueDevuelve([]);

    await exigirIdsExistentes(delegate, [], { entidad: "Estos productos" });

    expect(delegate.findMany).not.toHaveBeenCalled();
  });

  it("consulta solo los ids pedidos y solo la columna id", async () => {
    const delegate = delegateQueDevuelve([3, 4]);

    await exigirIdsExistentes(delegate, [3, 4], { entidad: "Estos productos" });

    expect(delegate.findMany).toHaveBeenCalledWith({
      where: { id: { in: [3, 4] } },
      select: { id: true },
    });
  });

  it("si todos existen no lanza", async () => {
    const delegate = delegateQueDevuelve([3, 4]);

    await expect(
      exigirIdsExistentes(delegate, [3, 4], { entidad: "Estas promociones" }),
    ).resolves.toBeUndefined();
  });

  it("nombra al que falta, con la frase de la entidad adelante", async () => {
    // Se nombra el que falta en vez de comparar largos: el mensaje sirve para
    // algo. Un "faltan datos" genérico obligaría al panel a adivinar cuál.
    const delegate = delegateQueDevuelve([3]);

    await expect(
      exigirIdsExistentes(delegate, [3, 999], { entidad: "Estos productos" }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Estos productos ya no existen: 999. Recargá la pantalla.",
    });
  });

  it("nombra a TODOS los que faltan, separados por coma", async () => {
    const delegate = delegateQueDevuelve([]);

    await expect(
      exigirIdsExistentes(delegate, [7, 8], { entidad: "Estas promociones" }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Estas promociones ya no existen: 7, 8. Recargá la pantalla.",
    });
  });

  it("un id repetido en la respuesta no marca falso faltante", async () => {
    // La comparación es por PERTENENCIA, no por cantidad: no depende de que la
    // consulta devuelva exactamente el conjunto pedido.
    const delegate = { findMany: vi.fn().mockResolvedValue([{ id: 3 }, { id: 3 }, { id: 4 }]) };

    await expect(
      exigirIdsExistentes(delegate, [3, 4], { entidad: "Estos productos" }),
    ).resolves.toBeUndefined();
  });
});
