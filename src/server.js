import "dotenv/config";
import cors from "cors";
import express from "express";
import productsRouter from "./routes/products.routes.js";
import categoriasRouter from "./routes/categorias.routes.js";

const app = express();
const PORT = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN?.split(",") ?? "http://localhost:5173";

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api/products", productsRouter);
app.use("/api/categorias", categoriasRouter);

// 404 fallback for unknown routes
app.use((_req, res) => {
  res.status(404).json({ error: "Recurso no encontrado." });
});

// Central error handler — never leak raw stack traces to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);

  if (err?.name === "MulterError") {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: mapMulterError(err) });
  }

  const status = err?.status ?? 500;
  const mensaje = status === 500 ? "Error interno del servidor." : err.message;
  res.status(status).json({ error: mensaje });
});

function mapMulterError(err) {
  if (err.code === "LIMIT_FILE_SIZE") return "El archivo supera el tamaño máximo permitido.";
  if (err.code === "LIMIT_UNEXPECTED_FILE") {
    // multer reuses this code both for a genuinely unknown field name and
    // for exceeding a field's maxCount — err.field tells them apart.
    if (err.field === "fotos") return "Se permiten máximo 4 fotos por producto.";
    if (err.field === "video") return "Se permite máximo 1 video por producto.";
    return "Campo de archivo inesperado.";
  }
  return "Error al procesar el archivo subido.";
}

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
