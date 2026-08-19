import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function mapCategoria(categoria) {
  return {
    id: categoria.id,
    nombre: categoria.nombre,
    cantidadProductos: categoria._count?.productos ?? 0,
  };
}

export async function listar(_req, res, next) {
  try {
    const categorias = await prisma.categoria.findMany({
      orderBy: { nombre: "asc" },
      include: { _count: { select: { productos: true } } },
    });
    res.json(categorias.map(mapCategoria));
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  try {
    const nombre = req.body?.nombre?.trim();
    if (!nombre) throw httpError(400, "El nombre de la categoría es obligatorio.");

    const existente = await prisma.categoria.findUnique({ where: { nombre } });
    if (existente) throw httpError(400, "Ya existe una categoría con ese nombre.");

    const categoria = await prisma.categoria.create({
      data: { nombre },
      include: { _count: { select: { productos: true } } },
    });

    // Fire-and-forget: la respuesta no espera el insert de auditoría.
    logAudit(req, {
      accion: "CREAR",
      entidad: "Categoria",
      entidadId: categoria.id,
      detalle: { nombre: categoria.nombre },
    });

    res.status(201).json(mapCategoria(categoria));
  } catch (err) {
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Categoría no encontrada.");

    const nombre = req.body?.nombre?.trim();
    if (!nombre) throw httpError(400, "El nombre de la categoría es obligatorio.");

    const actual = await prisma.categoria.findUnique({ where: { id } });
    if (!actual) throw httpError(404, "Categoría no encontrada.");

    if (nombre !== actual.nombre) {
      const duplicada = await prisma.categoria.findUnique({ where: { nombre } });
      if (duplicada) throw httpError(400, "Ya existe una categoría con ese nombre.");
    }

    const categoria = await prisma.categoria.update({
      where: { id },
      data: { nombre },
      include: { _count: { select: { productos: true } } },
    });

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Categoria",
      entidadId: categoria.id,
      detalle: { nombreAnterior: actual.nombre, nombreNuevo: categoria.nombre },
    });

    res.json(mapCategoria(categoria));
  } catch (err) {
    next(err);
  }
}

export async function eliminar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Categoría no encontrada.");

    const categoria = await prisma.categoria.findUnique({ where: { id } });
    if (!categoria) throw httpError(404, "Categoría no encontrada.");

    const cantidadProductos = await prisma.product.count({ where: { categoriaId: id } });
    if (cantidadProductos > 0) {
      throw httpError(
        400,
        `No se puede eliminar: ${cantidadProductos} producto${cantidadProductos === 1 ? "" : "s"} usa${cantidadProductos === 1 ? "" : "n"} esta categoría.`,
      );
    }

    await prisma.categoria.delete({ where: { id } });

    logAudit(req, {
      accion: "ELIMINAR",
      entidad: "Categoria",
      entidadId: id,
      detalle: { nombre: categoria.nombre },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
