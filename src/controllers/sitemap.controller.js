import { prisma } from "../lib/prisma.js";
import { rutaProducto, rutaCategoria, rutaCombo } from "../lib/slug.js";
import { condicionComboVigente } from "../lib/combos.js";
import { urlFrontend } from "../lib/urlsPublicas.js";

/**
 * Tope de URLs de producto en el sitemap. El endpoint es público, sin auth y
 * con rate limit laxo: un `findMany` sin `take` cargaba el catálogo entero en
 * cada request. 5000 está muy por encima de cualquier catálogo plausible de
 * este negocio y muy por debajo del máximo del protocolo (50.000 URLs por
 * archivo). Si alguna vez se supera, se recorta por los productos
 * actualizados más recientemente — los que más le importan a un crawler.
 */
const MAX_URLS_SITEMAP = 5000;

function escapeXml(texto) {
  return String(texto)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function entrada(loc, lastmod) {
  const mod = lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : "";
  return `  <url>\n    <loc>${escapeXml(loc)}</loc>${mod}\n  </url>`;
}

export async function servirSitemap(req, res, next) {
  try {
    const frontendUrl = urlFrontend();

    // Las tres consultas son independientes: en paralelo.
    const [productos, categorias, combos] = await Promise.all([
      prisma.product.findMany({
        where: { visibleEnCatalogo: true },
        orderBy: { updatedAt: "desc" },
        take: MAX_URLS_SITEMAP,
        // `nombre` es nuevo: sin él no se puede armar el slug, y la URL del
        // sitemap TIENE que ser idéntica al canonical que declara la página.
        select: { id: true, nombre: true, updatedAt: true },
      }),
      prisma.categoria.findMany({ select: { id: true, nombre: true } }),
      // Solo VIGENTES: un combo no vigente es 404 + noindex en `/og/combo`, y
      // una URL muerta en el sitemap es una señal contradictoria. Agotado sí
      // entra: sigue siendo 200 indexable.
      prisma.combo.findMany({
        where: condicionComboVigente(new Date()),
        orderBy: { updatedAt: "desc" },
        take: MAX_URLS_SITEMAP,
        select: { id: true, nombre: true, updatedAt: true },
      }),
    ]);

    const urls = [
      entrada(`${frontendUrl}/`),
      entrada(`${frontendUrl}/coleccion`),
      entrada(`${frontendUrl}/combos`),
      // `rutaCategoria` devuelve null cuando el nombre no deja slug (sin id
      // en esa ruta no hay fallback posible) — se omite esa entrada en vez
      // de publicar una URL ambigua.
      ...categorias
        .map((c) => rutaCategoria(c))
        .filter((ruta) => ruta !== null)
        .map((ruta) => entrada(`${frontendUrl}${ruta}`)),
      ...productos.map((p) => entrada(`${frontendUrl}${rutaProducto(p)}`, p.updatedAt.toISOString())),
      // `rutaCombo`: el mismo string que el canonical de `/og/combo` y el
      // `MetaSeo` de `PaginaCombo.jsx`.
      ...combos.map((c) => entrada(`${frontendUrl}${rutaCombo(c)}`, c.updatedAt.toISOString())),
    ];

    // Sin `priority` ni `changefreq`: Google los ignora desde hace años.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;

    res.status(200).type("application/xml").send(xml);
  } catch (err) {
    next(err);
  }
}
