/**
 * Migra los valores `WHATSAPP_*` del entorno a la fila única de
 * `ConfiguracionContacto`, SOLO para las columnas que hoy están en NULL.
 *
 * Se corre una única vez después de deployar la migración que crea la tabla
 * (`20260913142301_agregar_configuracion_contacto`), para que Configuración ›
 * Contacto arranque mostrando lo que ya estaba configurado por variables de
 * entorno en vez de una pantalla vacía. **NUNCA pisa un valor que un admin ya
 * haya guardado desde el panel** — por eso cada campo se copia solo si está
 * en NULL, campo por campo, nunca "si la fila entera está vacía".
 *
 * Uso: node src/scripts/migrar-contacto-desde-env.js
 */
import "dotenv/config";
import { prisma } from "../lib/prisma.js";

const ID_CONFIGURACION = 1;

function diasDesdeEnv() {
  return (process.env.WHATSAPP_DIAS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d !== "")
    .join(",");
}

async function main() {
  // Se asegura de que la fila exista (la migración ya la siembra, pero un
  // ambiente donde se corrió a mano sin la semilla no debería hacer fallar
  // este script).
  const actual = await prisma.configuracionContacto.upsert({
    where: { id: ID_CONFIGURACION },
    update: {},
    create: { id: ID_CONFIGURACION },
  });

  const datos = {};

  if (actual.whatsappNumero === null && process.env.WHATSAPP_NUMERO) {
    datos.whatsappNumero = process.env.WHATSAPP_NUMERO;
  }
  if (actual.whatsappHoraDesde === null && process.env.WHATSAPP_HORA_DESDE) {
    const numero = Number(process.env.WHATSAPP_HORA_DESDE);
    if (Number.isInteger(numero)) datos.whatsappHoraDesde = numero;
  }
  if (actual.whatsappHoraHasta === null && process.env.WHATSAPP_HORA_HASTA) {
    const numero = Number(process.env.WHATSAPP_HORA_HASTA);
    if (Number.isInteger(numero)) datos.whatsappHoraHasta = numero;
  }
  if (actual.whatsappDias === null && process.env.WHATSAPP_DIAS) {
    const dias = diasDesdeEnv();
    if (dias !== "") datos.whatsappDias = dias;
  }

  if (Object.keys(datos).length === 0) {
    console.log(
      "Nada que migrar: la fila ya tiene datos guardados en todos los campos, o no hay variables WHATSAPP_* configuradas.",
    );
    await prisma.$disconnect();
    return;
  }

  await prisma.configuracionContacto.update({ where: { id: ID_CONFIGURACION }, data: datos });
  console.log("Migrado desde el entorno:", datos);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
