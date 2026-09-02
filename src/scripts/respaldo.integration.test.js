import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "../lib/prisma.js";
import { respaldar, restaurar } from "../lib/respaldo.ejecutor.js";

/**
 * Ida y vuelta REAL contra la base: respaldar, borrar, restaurar, comparar.
 *
 * POR QUÉ TIENE QUE SER DE INTEGRACIÓN. El fallo que este test existe para
 * atrapar no se puede reproducir con mocks: SQL Server rechaza insertar un id
 * explícito en una columna IDENTITY (`IDENTITY_INSERT is set to OFF`), y eso
 * hacía que el respaldo se generara perfecto y fuera IMPOSIBLE de restaurar.
 * Un backup que no se puede restaurar no es un backup, y solo una base real
 * lo demuestra.
 *
 * Se auto-saltea cuando no hay base alcanzable, igual que los otros tests de
 * integración del repo, así que el CI queda verde sin credenciales.
 *
 * OPERA SOBRE UN ESQUEMA APARTE (`respaldo_test`), NUNCA sobre las tablas
 * reales: este test borra todo lo que toca, y correrlo contra la base de
 * desarrollo de alguien sería destruir su trabajo.
 */
let hayBase = false;

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    hayBase = true;
  } catch {
    hayBase = false;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.runIf(process.env.RESPALDO_TEST_DESTRUCTIVO === "1")(
  "respaldo y restauración contra base real",
  () => {
    let carpeta;

    beforeAll(async () => {
      carpeta = await mkdtemp(path.join(tmpdir(), "yima-respaldo-"));
    });

    afterAll(async () => {
      if (carpeta) await rm(carpeta, { recursive: true, force: true });
    });

    it("preserva los IDs exactos al restaurar", async () => {
      if (!hayBase) return;

      const idsAntes = (await prisma.product.findMany({ select: { id: true } })).map((p) => p.id);
      const { archivo } = await respaldar({ prisma, destino: carpeta });

      await restaurar({ prisma, archivo });

      const idsDespues = (await prisma.product.findMany({ select: { id: true } })).map((p) => p.id);
      expect(idsDespues.sort()).toEqual(idsAntes.sort());
    }, 600_000);

    it("preserva los montos como Decimal, no como float", async () => {
      if (!hayBase) return;

      const antes = await prisma.product.findFirst({
        where: { costo: { not: null } },
        select: { id: true, precio: true, costo: true, coeficiente: true },
      });
      if (!antes) return;

      const { archivo } = await respaldar({ prisma, destino: carpeta });
      await restaurar({ prisma, archivo });

      const despues = await prisma.product.findUnique({
        where: { id: antes.id },
        select: { precio: true, costo: true, coeficiente: true },
      });

      expect(despues.precio.toString()).toBe(antes.precio.toString());
      expect(despues.costo.toString()).toBe(antes.costo.toString());
      expect(despues.coeficiente.toString()).toBe(antes.coeficiente.toString());
    }, 600_000);

    it("deja las secuencias IDENTITY listas para un alta nueva", async () => {
      if (!hayBase) return;

      const { archivo } = await respaldar({ prisma, destino: carpeta });
      await restaurar({ prisma, archivo });

      // El caso que rompe si el reseed no corre: la próxima inserción reusa un
      // id ya ocupado y falla por PK, o peor, la secuencia arranca en 1 y
      // colisiona con las filas restauradas.
      const creada = await prisma.categoria.create({
        data: { nombre: `__test_reseed_${Date.now()}` },
      });
      expect(creada.id).toBeGreaterThan(0);
      await prisma.categoria.delete({ where: { id: creada.id } });
    }, 600_000);
  },
);
