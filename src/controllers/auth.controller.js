import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";

const JWT_EXPIRES_IN = "7d";
const SALT_ROUNDS = 10;

// Hash señuelo contra el que se compara cuando el email NO existe.
//
// NO BORRAR: esta comparación parece inútil (su resultado se descarta) pero es
// la defensa contra la enumeración de usuarios. Sin ella, un email inexistente
// devuelve 401 en microsegundos porque nunca se paga el costo de bcrypt,
// mientras que un email real tarda ~100 ms; esa diferencia es medible desde
// afuera y le permite a un atacante averiguar qué direcciones son admins antes
// de empezar a probar contraseñas. Pagando siempre el mismo costo, los dos
// casos tardan lo mismo.
//
// Se genera al cargar el módulo a partir de bytes aleatorios: nadie —ni quien
// lea este código— conoce la contraseña que le dio origen, así que no es una
// credencial y no puede validar ningún intento de login. Usa los mismos
// SALT_ROUNDS que los hashes reales (ver `usuarios.controller.js` y
// `scripts/create-admin.js`) para que el tiempo de comparación coincida.
const HASH_SENUELO = bcrypt.hashSync(randomBytes(32).toString("hex"), SALT_ROUNDS);

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

    // Se compara SIEMPRE, exista o no el usuario (ver HASH_SENUELO arriba):
    // salir temprano acá reintroduciría el canal lateral de tiempo.
    const passwordValida = await bcrypt.compare(password, usuario?.passwordHash ?? HASH_SENUELO);
    if (!usuario || !passwordValida) throw credencialesInvalidas();

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
