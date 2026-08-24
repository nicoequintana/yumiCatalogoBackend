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
import anunciosRouter from "./routes/anuncios.routes.js";
import ogRouter from "./routes/og.routes.js";
import sitemapRouter from "./routes/sitemap.routes.js";
import robotsRouter from "./routes/robots.routes.js";
import authRouter from "./routes/auth.routes.js";
import usuariosRouter from "./routes/usuarios.routes.js";
import adminRouter from "./routes/admin.routes.js";
import configRouter from "./routes/config.routes.js";
import eventosRouter from "./routes/eventos.routes.js";
import ordenesRouter from "./routes/ordenes.routes.js";
import clientesRouter from "./routes/clientes.routes.js";
import { manejadorDeErrores } from "./middlewares/errorHandler.js";
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
app.use("/api/anuncios", anunciosRouter);
app.use("/api/admin", adminRouter);
app.use("/api/config", configRouter);
app.use("/api/eventos", eventosRouter);
app.use("/api/ordenes", ordenesRouter);
app.use("/api/clientes", clientesRouter);
app.use("/og", ogRouter);
app.use("/sitemap.xml", sitemapRouter);
app.use("/robots.txt", robotsRouter);

// 404 fallback for unknown routes
app.use((_req, res) => {
  res.status(404).json({ error: "Recurso no encontrado." });
});

// Manejador central de errores. La implementación vive en
// `middlewares/errorHandler.js` para que los `buildApp()` de la suite de tests
// monten EXACTAMENTE este mismo handler, en vez de una versión simplificada que
// dejaba pasar aserciones que producción nunca cumpliría.
app.use(manejadorDeErrores);

const server = app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});

// EasyPanel manda SIGTERM en cada redeploy: sin esto, las requests en vuelo se
// cortan a mitad de respuesta y las transacciones abiertas quedan colgando.
registrarApagadoElegante({ server, prisma });
