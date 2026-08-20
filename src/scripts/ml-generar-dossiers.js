/**
 * Fase 1 de la generación de fichas desde MercadoLibre: convierte un Excel de
 * (nombre + url) en un JSON de hechos objetivos, listo para que Claude Code
 * redacte la ficha siguiendo docs/instructivo-ficha-producto.md.
 *
 * Uso: node src/scripts/ml-generar-dossiers.js <entrada.xlsx> <dossiers.json>
 *
 * Ver docs/superpowers/specs/2026-08-19-generacion-fichas-desde-ml-design.md
 */
import "dotenv/config";
import fs from "node:fs/promises";
import ExcelJS from "exceljs";
import { crearClienteML, extraerIdML } from "../lib/mercadoLibre.js";
import { prisma } from "../lib/prisma.js";

/** Pausa entre publicaciones para no golpear el rate limit de ML. */
const PAUSA_MS = 300;

const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function leerEntrada(ruta) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ruta);

  const hoja = wb.worksheets[0];
  if (!hoja) throw new Error(`El archivo ${ruta} no tiene ninguna hoja.`);

  const filas = [];
  hoja.eachRow((fila, numero) => {
    if (numero === 1) return; // encabezado
    const nombre = String(fila.getCell(1).value ?? "").trim();
    // Un link pegado en Excel llega como hipervínculo ({ text, hyperlink }),
    // no como texto plano — se toma el texto visible en ese caso.
    const celdaUrl = fila.getCell(2).value;
    const url = String(celdaUrl?.hyperlink ?? celdaUrl?.text ?? celdaUrl ?? "").trim();
    if (nombre === "" && url === "") return;
    filas.push({ nombre, url });
  });

  return filas;
}

async function main() {
  const [, , rutaEntrada, rutaSalida] = process.argv;

  if (!rutaEntrada || !rutaSalida) {
    console.error("Uso: node src/scripts/ml-generar-dossiers.js <entrada.xlsx> <dossiers.json>");
    process.exit(1);
  }

  // Se falla temprano y con mensaje claro: no tiene sentido leer el Excel ni
  // pegarle a la red si las credenciales no están.
  const { ML_CLIENT_ID, ML_CLIENT_SECRET } = process.env;
  if (!ML_CLIENT_ID || !ML_CLIENT_SECRET) {
    console.error("Faltan ML_CLIENT_ID y/o ML_CLIENT_SECRET en backend/.env — ver .env.example.");
    process.exit(1);
  }

  const filas = await leerEntrada(rutaEntrada);
  console.log(`Leídas ${filas.length} filas de ${rutaEntrada}.`);

  // Las categorías vigentes viajan en el dossier para que la redacción solo
  // proponga categorías que existen: el importador rechaza la fila entera si
  // la categoría no está en la base.
  const categorias = await prisma.categoria.findMany({ select: { nombre: true } });
  const categoriasVigentes = categorias.map((categoria) => categoria.nombre);

  const cliente = crearClienteML({ clientId: ML_CLIENT_ID, clientSecret: ML_CLIENT_SECRET });
  const productos = [];

  for (const [indice, fila] of filas.entries()) {
    const etiqueta = `[${indice + 1}/${filas.length}] ${fila.nombre || fila.url}`;
    const id = extraerIdML(fila.url);

    if (!id) {
      console.warn(`${etiqueta} — sin id de ML en la URL, se marca y se sigue.`);
      productos.push({ ...fila, estado: "error", motivoError: "La URL no contiene un id de MercadoLibre." });
      continue;
    }

    try {
      const hechos = await cliente.traerDossier(id);
      productos.push({ ...fila, estado: "ok", hechos });
      console.log(`${etiqueta} — ok${hechos.titulo === null ? " (solo descripción: /items sigue cerrado)" : ""}`);
    } catch (err) {
      // Una publicación caída no puede voltear el lote entero.
      console.warn(`${etiqueta} — ${err.message}`);
      productos.push({ ...fila, estado: "error", motivoError: err.message });
    }

    await dormir(PAUSA_MS);
  }

  await fs.writeFile(
    rutaSalida,
    JSON.stringify({ generadoEl: new Date().toISOString(), categoriasVigentes, productos }, null, 2),
    "utf8",
  );

  const ok = productos.filter((producto) => producto.estado === "ok").length;
  console.log(`\nEscrito ${rutaSalida}: ${ok} ok, ${productos.length - ok} con error.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
