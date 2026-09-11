import jwt from "jsonwebtoken";
import { prisma } from "../lib/prisma.js";
import { httpError } from "../lib/httpError.js";
import { logError } from "../lib/logError.js";
import { HASH_SENUELO, compararPassword, hashearPassword, necesitaRehash } from "../lib/passwords.js";
import { estaBajoPresion, reservarSlot } from "../lib/colaBcrypt.js";

// Ventana de vida del token. Se bajó de 7 días a 24 horas para acotar la
// exposición de un token robado que pase inadvertido: la revocación por
// `tokenVersion` cierra las sesiones en el acto cuando el admin cambia su
// contraseña, pero no cubre un robo silencioso donde la víctima no cambia nada.
// Contra ese caso, la única defensa es que el token caduque pronto.
const JWT_EXPIRES_IN = "24h";

/**
 * Re-hashea la contraseña con el costo vigente después de un login exitoso.
 *
 * Es la forma de subir el costo de bcrypt sin migración y sin pedirle la
 * clave a nadie: cada admin lo hace solo la próxima vez que entra. Corre
 * DESPUÉS de responder y nunca lanza — un fallo acá no puede convertir un
 * login válido en un error.
 */
function rehashSiHaceFalta({ id, passwordHash }, password) {
  if (!necesitaRehash(passwordHash)) return;
  hashearPassword(password)
    .then((nuevo) => prisma.usuario.update({ where: { id }, data: { passwordHash: nuevo } }))
    .catch((err) => {
      logError({ mensaje: `No se pudo re-hashear la contraseña del usuario ${id}`, stack: err.stack, causa: err });
    });
}

export async function login(req, res, next) {
  let liberarSlot = null;
  try {
    const email = req.body?.email?.trim();
    const password = req.body?.password;

    if (!email || !password) {
      throw httpError(400, "Email y contraseña son obligatorios.");
    }

    // ANTES de la base: si se reservara después del findUnique, con la cola
    // llena "cuenta existente" daría 503 y "inexistente" 401 rápido — un
    // oráculo por código de estado que anula el señuelo del login.
    liberarSlot = await reservarSlot();

    const credencialesInvalidas = () => httpError(401, "Email o contraseña incorrectos.");

    const usuario = await prisma.usuario.findUnique({ where: { email } });

    // Se compara SIEMPRE, exista o no el usuario (ver HASH_SENUELO en
    // lib/passwords.js): salir temprano acá reintroduciría el canal lateral
    // de tiempo — un email inexistente respondería en microsegundos y uno
    // existente en ~120 ms, y ese tiempo revela qué cuentas hay.
    const passwordValida = await compararPassword(password, usuario?.passwordHash ?? HASH_SENUELO);
    if (!usuario || !passwordValida) throw credencialesInvalidas();

    // `email` viaja en el payload junto al `sub` para que `requireAuth` pueda
    // exponer la identidad completa del admin en `req.usuario` sin pegarle a
    // la DB en cada request. Solo datos de identificación — nunca el
    // passwordHash ni ningún otro secreto: el payload de un JWT va firmado,
    // no cifrado, y cualquiera con el token puede leerlo.
    //
    // `tokenVersion` es la versión de sesión con la que se emite el token.
    // `requireAuth` la compara contra la columna homónima de `Usuario`: cuando
    // el admin cambia su contraseña, la columna se incrementa y todos los
    // tokens emitidos antes quedan revocados. NO es un secreto — es un contador.
    const token = jwt.sign(
      { sub: usuario.id, email: usuario.email, tokenVersion: usuario.tokenVersion },
      process.env.JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    );

    res.json({ token });

    // Bajo presión no se re-hashea: sería una segunda operación de bcrypt
    // solo cuando la clave es correcta, y el 503 pasaría a discriminar
    // credenciales válidas.
    if (!estaBajoPresion()) rehashSiHaceFalta(usuario, password);
  } catch (err) {
    next(err);
  } finally {
    if (liberarSlot) liberarSlot();
  }
}
