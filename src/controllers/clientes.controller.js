import { prisma } from "../lib/prisma.js";
import { normalizarDni } from "../lib/dni.js";

/**
 * GET /api/clientes/:dni/ordenes — historial completo de órdenes de un
 * cliente, protegido con requireAuth. El DNI llega en la URL y puede venir
 * con puntos/espacios si un admin lo tipea a mano, así que se normaliza con
 * el mismo `normalizarDni` que usa `ordenes.controller.js`'s `crear()` antes
 * de filtrar.
 *
 * Si no existe ningún cliente con ese DNI, devuelve un array vacío (200),
 * NO un 404: un admin buscando un DNI sin historial no es un caso de error,
 * es un resultado válido de "no hay nada". El filtro por relación
 * (`where: { cliente: { dni } }`) ya resuelve esto solo — si no hay cliente
 * con ese dni, `findMany` simplemente no matchea ninguna orden.
 */
export async function obtenerHistorialCliente(req, res, next) {
  try {
    const dni = normalizarDni(req.params.dni);

    const ordenes = await prisma.orden.findMany({
      where: { cliente: { dni } },
      orderBy: { createdAt: "desc" },
      include: { items: true },
    });

    res.json(ordenes);
  } catch (err) {
    next(err);
  }
}
