/**
 * Fase 3 de la generación de fichas desde MercadoLibre: toma el JSON que
 * produjo la redacción y escribe el .xlsx que consume el importador del admin.
 *
 * Uso: node src/scripts/ml-generar-planilla.js <redacciones.json> <salida.xlsx> [dossiers.json]
 */
import fs from "node:fs/promises";
import { construirPlanilla, validarRedacciones } from "../lib/planillaGenerada.js";

async function main() {
  const [, , rutaEntrada, rutaSalida, rutaDossiers] = process.argv;

  if (!rutaEntrada || !rutaSalida) {
    console.error("Uso: node src/scripts/ml-generar-planilla.js <redacciones.json> <salida.xlsx> [dossiers.json]");
    process.exit(1);
  }

  const redacciones = JSON.parse(await fs.readFile(rutaEntrada, "utf8"));

  // dossiers.json es OPCIONAL a propósito: trae categoriasVigentes sin que
  // este script tenga que importar Prisma (se mantiene DB-free). Sin este
  // tercer argumento, la categoría no se valida (mismo comportamiento que antes).
  let categoriasVigentes;
  if (rutaDossiers) {
    const dossiers = JSON.parse(await fs.readFile(rutaDossiers, "utf8"));
    categoriasVigentes = dossiers.categoriasVigentes;
  }

  const errores = validarRedacciones(redacciones, { categoriasVigentes });

  if (errores.length > 0) {
    console.error("El archivo de redacciones tiene problemas:\n");
    errores.forEach((error) => console.error(`  - ${error}`));
    process.exit(1);
  }

  const wb = await construirPlanilla(redacciones);
  await wb.xlsx.writeFile(rutaSalida);

  console.log(`Escrito ${rutaSalida} con ${redacciones.length} productos.`);
  console.log("Antes de importar: completá precio y stock, y verificá que las especificaciones");
  console.log("coincidan con el producto que realmente vendés (la publicación de ML no es tuya).");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
