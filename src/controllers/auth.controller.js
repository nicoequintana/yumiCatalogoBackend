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

    // `email` viaja en el payload junto al `sub` para que `requireAuth` pueda
    // exponer la identidad completa del admin en `req.usuario` sin pegarle a
    // la DB en cada request. Solo datos de identificación — nunca el
    // passwordHash ni ningún otro secreto: el payload de un JWT va firmado,
    // no cifrado, y cualquiera con el token puede leerlo.
    const token = jwt.sign({ sub: usuario.id, email: usuario.email }, process.env.JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });
    res.json({ token });
  } catch (err) {
    next(err);
  }
}
