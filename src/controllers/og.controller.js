import { prisma } from "../lib/prisma.js";
import { esBot } from "../lib/botDetector.js";
import { truncarDescripcion, resolverImagenOg } from "../lib/ogMeta.js";

const DESCRIPCION_MAX_LENGTH = 160;
const SITE_NAME = "YIMA Productos";

function escapeHtml(texto) {
  return String(texto)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderOgHtml({ title, description, image, url }) {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta property="og:type" content="product" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:image" content="${escapeHtml(image)}" />
    <meta property="og:url" content="${escapeHtml(url)}" />
    <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body></body>
</html>`;
}

export async function servirOgProducto(req, res, next) {
  try {
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    const backendUrl = process.env.BACKEND_PUBLIC_URL ?? "http://localhost:4000";

    const id = Number(req.params.id);
    const userAgent = req.headers["user-agent"];
    const productUrl = `${frontendUrl}/producto/${req.params.id}`;

    if (!esBot(userAgent)) {
      return res.redirect(302, productUrl);
    }

    // `Number.isInteger`, no `Number.isNaN`: un float ("1.5") no es NaN y
    // llegaría a Prisma como filtro sobre `id Int` → 500 en vez del HTML
    // genérico que ya reciben los ids no numéricos o inexistentes.
    const producto = !Number.isInteger(id) ? null : await prisma.product.findUnique({
      where: { id },
      include: { fotos: true },
    });

    if (!producto || !producto.visibleEnCatalogo) {
      const html = renderOgHtml({
        title: SITE_NAME,
        description: "Catálogo online de YIMA Productos.",
        image: `${frontendUrl}/og-default.png`,
        url: productUrl,
      });
      res.status(200).type("html").send(html);
      return;
    }

    const html = renderOgHtml({
      title: `${producto.nombre} — ${SITE_NAME}`,
      description: truncarDescripcion(producto.descripcion, DESCRIPCION_MAX_LENGTH),
      image: resolverImagenOg(producto, { frontendUrl, backendUrl }),
      url: productUrl,
    });

    res.status(200).type("html").send(html);
  } catch (err) {
    next(err);
  }
}
