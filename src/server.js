import "dotenv/config";
import cors from "cors";
import express from "express";
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

const app = express();
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:5173";

// Deploy en EasyPanel corre detrás de un reverse proxy: sin esto,
// express-rate-limit (y cualquier lectura de req.ip) vería la IP interna
// del proxy en vez de la IP real del cliente, agrupando a todos los
// usuarios en un mismo bucket de rate limit.
app.set("trust proxy", 1);

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

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
