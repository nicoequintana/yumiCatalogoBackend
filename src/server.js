import "dotenv/config";
// SEGUNDO import a propósito, antes de cualquier router: valida el entorno y
// corta el arranque con el listado completo de lo que falta. En ESM todos los
// imports se evalúan antes que la primera sentencia del módulo, así que esto
// NO puede ser una llamada a función más abajo — para entonces `lib/prisma.js`
// ya habría intentado construir el adapter con un DATABASE_URL inexistente.
// Ver `lib/env.boot.js` para el detalle.
import "./lib/env.boot.js";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import productsRouter from "./routes/products.routes.js";
import categoriasRouter from "./routes/categorias.routes.js";
import ogRouter from "./routes/og.routes.js";
import sitemapRouter from "./routes/sitemap.routes.js";
import authRouter from "./routes/auth.routes.js";
import usuariosRouter from "./routes/usuarios.routes.js";
import adminRouter from "./routes/admin.routes.js";
import configRouter from "./routes/config.routes.js";
import eventosRouter from "./routes/eventos.routes.js";
import ordenesRouter from "./routes/ordenes.routes.js";
import clientesRouter from "./routes/clientes.routes.js";
import { logError } from "./lib/logError.js";
import { prisma } from "./lib/prisma.js";
import { registrarApagadoElegante } from "./lib/apagadoElegante.js";
import { parsearOrigenesCors } from "./lib/corsOrigen.js";

const app = express();
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = parsearOrigenesCors(process.env.CORS_ORIGIN);

// Deploy en EasyPanel corre detrás de un reverse proxy: sin esto,
// express-rate-limit (y cualquier lectura de req.ip) vería la IP interna
// del proxy en vez de la IP real del cliente, agrupando a todos los
// usuarios en un mismo bucket de rate limit.
app.set("trust proxy", 1);

// Cabeceras de seguridad. La configuración es deliberada: los defaults de
// helmet rompen dos cosas de este backend en particular.
app.use(
  helmet({
    // CSP DESACTIVADA A PROPÓSITO. Este servicio expone JSON y streams de
    // medios, donde una CSP no aporta nada; el único HTML que sirve es
    // `/og/producto/:id`, pensado para los bots de redes sociales, que ni
    // siquiera evalúan CSP. En cambio el default de helmet
    // (`default-src 'self'`) sí bloquearía la `og:image` alojada en
    // Cloudinary si un humano abriera esa página. La CSP que importa de
    // verdad es la de la SPA, y esa se sirve desde nginx, no desde acá.
    contentSecurityPolicy: false,

    // El default de helmet es `same-origin`, y eso ROMPERÍA los medios: el
    // frontend vive en otro subdominio y carga las fotos y el video legado a
    // través del proxy del backend (`/api/products/:id/fotos/:fotoId` y
    // `/api/products/:id/video`). Con CORP en `same-origin` el browser
    // descarta esas respuestas en `<img>` y `<video>`.
    crossOriginResourcePolicy: { policy: "cross-origin" },

    // El admin no debe poder embeberse en un iframe de nadie: la pantalla de
    // login enmarcada es el vector clásico de clickjacking. `deny` en vez del
    // `sameorigin` que trae helmet, porque este backend no enmarca nada.
    frameguard: { action: "deny" },

    // HSTS DESACTIVADO A PROPÓSITO — no porque no convenga, sino porque es
    // una decisión de deploy sobre el dominio entero (y el default de helmet
    // incluye `includeSubDomains`, que afectaría a cualquier subdominio
    // vecino). Activarlo va junto con la decisión equivalente en nginx, no
    // por separado desde el código de la API.
    hsts: false,
  }),
);

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);
app.use("/api/usuarios", usuariosRouter);
app.use("/api/products", productsRouter);
app.use("/api/categorias", categoriasRouter);
app.use("/api/admin", adminRouter);
app.use("/api/config", configRouter);
app.use("/api/eventos", eventosRouter);
app.use("/api/ordenes", ordenesRouter);
app.use("/api/clientes", clientesRouter);
app.use("/og", ogRouter);
app.use("/sitemap.xml", sitemapRouter);

// 404 fallback for unknown routes
app.use((_req, res) => {
  res.status(404).json({ error: "Recurso no encontrado." });
});

// Central error handler — never leak raw stack traces to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(err);

  if (err?.name === "MulterError") {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    logError({
      mensaje: err.message,
      stack: err.stack,
      ruta: req.originalUrl,
      metodo: req.method,
      status,
    });
    return res.status(status).json({ error: mapMulterError(err) });
  }

  if (err?.code === "P2002") {
    const campo = Array.isArray(err.meta?.target) ? err.meta.target[0] : err.meta?.target;
    logError({
      mensaje: err.message,
      stack: err.stack,
      ruta: req.originalUrl,
      metodo: req.method,
      status: 400,
    });
    return res.status(400).json({ error: `Ya existe un registro con ese ${campo ?? "valor"}.` });
  }

  // P2003 = violación de clave foránea. El pre-chequeo de cada controller
  // (ver `productsController.eliminar` y `categoriasController.eliminar`) es
  // la defensa principal y da un mensaje puntual; esto es la red de
  // seguridad para cualquier relación que todavía no lo tenga, para que al
  // admin no le llegue un 500 opaco.
  if (err?.code === "P2003") {
    logError({
      mensaje: err.message,
      stack: err.stack,
      ruta: req.originalUrl,
      metodo: req.method,
      status: 400,
    });
    return res
      .status(400)
      .json({ error: "No se puede eliminar: otros registros dependen de este. Ocultalo en vez de borrarlo." });
  }

  const status = err?.status ?? 500;
  const mensaje = status === 500 ? "Error interno del servidor." : err.message;
  // Fire-and-forget: the response must not wait on the logging insert.
  logError({ mensaje: err?.message, stack: err?.stack, ruta: req.originalUrl, metodo: req.method, status });
  res.status(status).json({ error: mensaje });
});

function mapMulterError(err) {
  if (err.code === "LIMIT_FILE_SIZE") return "El archivo supera el tamaño máximo permitido.";
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    // multer reuses this code both for a genuinely unknown field name and
    // for exceeding a field's maxCount — err.field tells them apart.
    if (err.field === "fotos") return "Se permiten máximo 10 fotos por producto.";
    if (err.field === "video") return "Se permite máximo 1 video por producto.";
    return "Campo de archivo inesperado.";
  }
  return "Error al procesar el archivo subido.";
}

const server = app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});

// EasyPanel manda SIGTERM en cada redeploy: sin esto, las requests en vuelo se
// cortan a mitad de respuesta y las transacciones abiertas quedan colgando.
registrarApagadoElegante({ server, prisma });
