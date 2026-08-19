import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";

const JWT_EXPIRES_IN = "7d";

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export async function login(req, res, next) {
  try {
    const email = req.body?.email?.trim();
    const password = req.body?.password;
    if (!email || !password) {
      throw httpError(400, "Email y contraseña son obligatorios.");
    }

    const credencialesInvalidas = () => httpError(401, "Email o contraseña incorrectos.");

    const usuario = await prisma.usuario.findUnique({ where: { email } });
    if (!usuario) throw credencialesInvalidas();

    const passwordValida = await bcrypt.compare(password, usuario.passwordHash);
    if (!passwordValida) throw credencialesInvalidas();

    const token = jwt.sign({ sub: usuario.id }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    res.json({ token });
  } catch (err) {
    next(err);
  }
}
