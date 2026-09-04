import { httpError } from "./httpError.js";

/**
 * Falla con 400 si alguno de los ids pedidos ya no está en la base.
 *
 * Es el guard de las pantallas que editan una LISTA de asociaciones (los
 * productos de una promoción, las promociones de una campaña): el panel manda
 * ids que leyó hace un rato, y en el medio alguien pudo borrar uno. Sin este
 * chequeo la escritura explota como `P2003` (violación de FK), que el error
 * handler traduce a un 500 opaco — el admin ve "error del servidor" cuando lo
 * único que pasó es que la pantalla está vieja.
 *
 * Estaba copiado literal en dos controllers, con el mismo comentario. Vive acá
 * para que el mensaje y la decisión de nombrar al faltante tengan un solo dueño.
 *
 * `entidad` recibe la FRASE ENTERA ("Estos productos", "Estas promociones") y
 * no el sustantivo suelto: el género y el número cambian el artículo, y armarlo
 * acá obligaría a que el helper conozca la gramática de cada llamador.
 *
 * @param {{ findMany: (args: object) => Promise<Array<{ id: number }>> }} delegate
 *   El delegado de Prisma del modelo a verificar (`prisma.product`, `prisma.promocion`).
 * @param {number[]} ids - los ids que el panel mandó.
 * @param {{ entidad: string }} opciones
 */
export async function exigirIdsExistentes(delegate, ids, { entidad }) {
  // Sin ids no hay nada que verificar: un `in: []` es un round-trip a la base
  // garantizado a devolver cero filas. El caso vacío ("desasociar todo") es
  // frecuente, no excepcional.
  if (ids.length === 0) return;

  const existentes = await delegate.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });

  // Se nombra el que falta en vez de comparar largos: el mensaje sirve para
  // algo, y no depende de que la consulta devuelva exactamente el conjunto
  // pedido.
  const presentes = new Set(existentes.map((fila) => fila.id));
  const faltantes = ids.filter((id) => !presentes.has(id));
  if (faltantes.length > 0) {
    throw httpError(400, `${entidad} ya no existen: ${faltantes.join(", ")}. Recargá la pantalla.`);
  }
}
