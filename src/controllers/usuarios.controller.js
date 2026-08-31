import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { esEmailValido } from "../lib/emailValido.js";

const SALT_ROUNDS = 10;

/**
 * Mínimo de caracteres de la contraseña — la MISMA política que
 * `scripts/create-admin.js`. El endpoint HTTP había quedado más laxo que el
 * script de bootstrap (aceptaba "a" como contraseña), y la puerta que más se
 * usa no puede ser la más débil.
 */
const MIN_LARGO_PASSWORD = 8;

function validarEmail(email) {
  if (!esEmailValido(email)) {
    throw httpError(400, "El email no tiene un formato válido.");
  }
}

function validarPassword(password) {
  if (typeof password !== "string" || password.length < MIN_LARGO_PASSWORD) {
    throw httpError(400, `La contraseña debe tener al menos ${MIN_LARGO_PASSWORD} caracteres.`);
  }
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
    validarEmail(email);
    validarPassword(password);

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
      validarEmail(email);
      if (email !== actual.email) {
        const duplicado = await prisma.usuario.findUnique({ where: { email } });
        if (duplicado) throw httpError(400, "Ya existe un usuario con ese email.");
      }
      data.email = email;
    }

    if (password) {
      validarPassword(password);
      data.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      // Rotar la contraseña invalida TODOS los JWT emitidos antes del cambio:
      // `requireAuth` compara la versión del token contra esta columna y revoca
      // si difieren (ver `middlewares/auth.middleware.js`). Solo se incrementa
      // al cambiar la contraseña — cambiar el email no debe cerrar sesiones.
      data.tokenVersion = { increment: 1 };
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

    // Auto-borrado rechazado: es un accidente más probable que malicioso, y
    // con la revocación de sesión (`requireAuth` verifica que el usuario del
    // token exista) dejaría al admin sin sesión EN EL ACTO, sin aviso.
    if (req.usuario?.id === id) {
      throw httpError(400, "No podés eliminar tu propio usuario. Pedile a otro admin que lo haga.");
    }

    // Se lee el usuario ANTES de borrarlo solo para poder dejar su email en
    // la traza: una vez borrado, la fila ya no existe para consultarla.
    const aEliminar = await prisma.usuario.findUnique({ where: { id } });

    // La guarda de "no dejar la tabla sin admins" va DENTRO de la transacción
    // y DESPUÉS del borrado, no como un count() previo: aquel orden era un
    // TOCTOU — dos DELETE concurrentes con 2 usuarios veían count=2 cada uno
    // y dejaban la tabla en 0. Acá, si el recuento posterior da cero, el
    // throw revierte el borrado. `deleteMany` en vez de `delete` para que un
    // id inexistente sea un 404 y no el P2025 (=> 500) que tiraba `delete`.
    await prisma.$transaction(
      async (tx) => {
        const borrados = await tx.usuario.deleteMany({ where: { id } });
        if (borrados.count === 0) throw httpError(404, "Usuario no encontrado.");

        const restantes = await tx.usuario.count();
        if (restantes === 0) {
          throw httpError(400, "No se puede eliminar el único usuario admin restante.");
        }
      },
      // Serializable: bajo READ COMMITTED (o snapshot) dos borrados
      // concurrentes podrían no verse entre sí y contar 1 cada uno. Con este
      // nivel, uno de los dos se bloquea/aborta y la invariante se sostiene.
      { isolationLevel: "Serializable" },
    );

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
