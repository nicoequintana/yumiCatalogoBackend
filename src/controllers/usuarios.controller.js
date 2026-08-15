import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";

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

    await prisma.usuario.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}
