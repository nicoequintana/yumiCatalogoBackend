import { prisma } from "../lib/prisma.js";

function escapeXml(texto) {
  return String(texto)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function servirSitemap(req, res, next) {
  try {
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";

    const productos = await prisma.product.findMany({
      where: { visibleEnCatalogo: true },
      select: { id: true, updatedAt: true },
    });

    const urls = [
      `  <url>\n    <loc>${escapeXml(frontendUrl)}/</loc>\n  </url>`,
      ...productos.map((producto) => {
        const loc = `${frontendUrl}/producto/${producto.id}`;
        const lastmod = producto.updatedAt.toISOString();
        return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
      }),
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;

    res.status(200).type("application/xml").send(xml);
  } catch (err) {
    next(err);
  }
}
