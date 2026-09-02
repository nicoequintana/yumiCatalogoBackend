/**
 * Respaldo de los datos de la base a un único archivo JSON.
 *
 *   node --require dotenv/config src/scripts/backup-db.js [directorio]
 *
 * POR QUÉ NO ES UN `BACKUP DATABASE` de SQL Server. Ese comando escribe en el
 * filesystem DEL SERVIDOR, así que exige acceso al contenedor de la base y un
 * volumen montado para poder sacar el archivo. Este script corre desde donde ya
 * hay un `DATABASE_URL` —el contenedor del backend, o una máquina de
 * desarrollo— y no necesita nada de eso.
 *
 * QUÉ CUBRE Y QUÉ NO. Cubre los DATOS. El ESQUEMA vive en `prisma/migrations/`,
 * versionado en git; los dos juntos son una restauración completa. NO cubre los
 * archivos de Cloudinary, que son de otro servicio con su propia durabilidad.
 *
 * Procedimiento completo en `docs/deploy/backups.md`.
 */
import { prisma } from "../lib/prisma.js";
import { enmascararConexion } from "../lib/respaldo.js";
import { respaldar } from "../lib/respaldo.ejecutor.js";

async function main() {
  console.log(`Origen: ${enmascararConexion(process.env.DATABASE_URL)}\n`);

  const { archivo, total } = await respaldar({
    prisma,
    destino: process.argv[2] ?? "backups",
    alAvanzar: (modelo, filas) =>
      console.log(`  ${modelo.padEnd(16)} ${String(filas).padStart(6)} filas`),
  });

  console.log(`\n✔ ${total} filas -> ${archivo}`);

  // Un respaldo vacío es indistinguible de uno exitoso mirando el exit code, y
  // se descubre el día que hay que restaurarlo. Falla ruidosamente.
  if (total === 0) {
    console.warn("\n⚠ El respaldo salió VACÍO. Revisá que DATABASE_URL apunte a la base correcta.");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error("\n✖ El respaldo FALLÓ:", err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
