import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";

const SALT_ROUNDS = 10;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function mapUsuario(usuario) {
  return { id: usuario.id, email: usuario.email, createdAt: usuario.createdAt };
}

export async function listar(_req, res, next) {
  try {
    const usuarios = await prisma.usuario.findMany({
      orderBy: { email: "asc" },
      select: { id: true, email: true, createdAt: true },
    });
    res.json(usuarios.map(mapUsuario));
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  try {
    const email = req.body?.email?.trim();
    const password = req.body?.password;
    if (!email || !password) {
      throw httpError(400, "Email y contraseña son obligatorios.");
    }

    const existente = await prisma.usuario.findUnique({ where: { email } });
    if (existente) throw httpError(400, "Ya existe un usuario con ese email.");

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const usuario = await prisma.usuario.create({ data: { email, passwordHash } });

    // Se audita SOLO el email/id. Nunca el passwordHash ni la contraseña en
    // claro — la traza de auditoría es consultable desde el panel admin y no
    // puede convertirse en una vía de filtración de credenciales.
    logAudit(req, {
      accion: "CREAR",
      entidad: "Usuario",
      entidadId: usuario.id,
      detalle: { email: usuario.email },
    });

    res.status(201).json(mapUsuario(usuario));
  } catch (err) {
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Usuario no encontrado.");

    const actual = await prisma.usuario.findUnique({ where: { id } });
    if (!actual) throw httpError(404, "Usuario no encontrado.");

    const email = req.body?.email?.trim();
    const password = req.body?.password;

    const data = {};

    if (email !== undefined && email !== "") {
      if (email !== actual.email) {
        const duplicado = await prisma.usuario.findUnique({ where: { email } });
        if (duplicado) throw httpError(400, "Ya existe un usuario con ese email.");
      }
      data.email = email;
    }

    if (password) {
      data.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    }

    const usuario = await prisma.usuario.update({ where: { id }, data });

    // `passwordCambiada` es un booleano a propósito: deja constancia de que
    // la credencial se rotó sin registrar ni la clave nueva ni su hash.
    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Usuario",
      entidadId: usuario.id,
      detalle: {
        emailAnterior: actual.email,
        emailNuevo: usuario.email,
        passwordCambiada: Boolean(password),
      },
    });

    res.json(mapUsuario(usuario));
  } catch (err) {
    next(err);
  }
}

export async function eliminar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) throw httpError(404, "Usuario no encontrado.");

    const total = await prisma.usuario.count();
    if (total <= 1) {
      throw httpError(400, "No se puede eliminar el único usuario admin restante.");
    }

    // Se lee el usuario ANTES de borrarlo solo para poder dejar su email en
    // la traza: una vez borrado, la fila ya no existe para consultarla.
    const aEliminar = await prisma.usuario.findUnique({ where: { id } });

    await prisma.usuario.delete({ where: { id } });

    logAudit(req, {
      accion: "ELIMINAR",
      entidad: "Usuario",
      entidadId: id,
      detalle: aEliminar ? { email: aEliminar.email } : null,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
