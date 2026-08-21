/**
 * Bootstrap del primer usuario admin. Se corre una única vez a mano tras el
 * deploy inicial (no hay endpoint HTTP de registro — decisión de diseño,
 * ver docs/superpowers/specs/2026-08-15-auth-admin-design.md).
 *
 * Uso: node src/scripts/create-admin.js <email> <password>
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";

const SALT_ROUNDS = 10;

async function main() {
  const [, , email, password] = process.argv;

  if (!email || !password) {
    console.error("Uso: node src/scripts/create-admin.js <email> <password>");
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("La contraseña debe tener al menos 8 caracteres.");
    process.exit(1);
  }

  const existente = await prisma.usuario.findUnique({ where: { email } });
  if (existente) {
    console.error(`Ya existe un usuario con el email ${email}.`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const usuario = await prisma.usuario.create({ data: { email, passwordHash } });

  console.log(`Usuario admin creado: ${usuario.email} (id ${usuario.id})`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
