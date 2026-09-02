/**
 * Restaura un respaldo generado por `backup-db.js`.
 *
 *   node --require dotenv/config src/scripts/restore-db.js <archivo.json> --si-borrar-todo
 *
 * ES DESTRUCTIVO: vacía cada tabla antes de insertar. Por eso exige el flag
 * explícito y no corre sin él — el escenario de uso es una emergencia, y en una
 * emergencia nadie lee la ayuda del comando.
 *
 * ANTES DE RESTAURAR corré `prisma migrate deploy`: este script llena tablas,
 * no las crea. Ver `docs/deploy/backups.md`.
 */
import { prisma } from "../lib/prisma.js";
import { enmascararConexion } from "../lib/respaldo.js";
import { restaurar } from "../lib/respaldo.ejecutor.js";
import { readFile } from "node:fs/promises";

async function main() {
  const archivo = process.argv[2];
  const confirmado = process.argv.includes("--si-borrar-todo");

  if (!archivo) {
    console.error("Uso: node src/scripts/restore-db.js <archivo.json> --si-borrar-todo");
    process.exitCode = 1;
    return;
  }

  const respaldo = JSON.parse(await readFile(archivo, "utf8"));
  const total = Object.values(respaldo.conteos ?? {}).reduce((a, b) => a + b, 0);

  console.log(`Respaldo del ${respaldo.generadoEn} — ${total} filas.`);
  console.log(`Destino: ${enmascararConexion(process.env.DATABASE_URL)}\n`);

  if (!confirmado) {
    console.error(
      "✖ Falta --si-borrar-todo.\n" +
        "  Este comando VACÍA todas las tablas del destino antes de insertar.\n" +
        "  Verificá que DATABASE_URL sea la base que querés sobrescribir.",
    );
    process.exitCode = 1;
    return;
  }

  await restaurar({
    prisma,
    archivo,
    alAvanzar: (modelo, filas) =>
      console.log(`  ${modelo.padEnd(16)} ${String(filas).padStart(6)} filas`),
  });

  console.log(`\n✔ Restauradas ${total} filas, con sus ids originales.`);
}

main()
  .catch((err) => {
    console.error("\n✖ La restauración FALLÓ (no se aplicó nada):", err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
