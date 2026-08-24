import { prisma } from "../lib/prisma.js";
import { esBot } from "../lib/botDetector.js";
import { truncarDescripcion, resolverImagenOg } from "../lib/ogMeta.js";
import { renderHtmlSeo } from "../lib/htmlSeo.js";
import { jsonLdProducto, jsonLdBreadcrumb } from "../lib/jsonLd.js";
import { parsearIdDeRuta, rutaProducto } from "../lib/slug.js";
import { PRODUCT_INCLUDE } from "./products.mapper.js";
import { cuerpoProducto } from "./seo.cuerpo.js";
import { urlFrontend, urlBackend } from "../lib/urlsPublicas.js";

/**
 * HTML server-side para crawlers.
 *
 * Este archivo reemplaza al viejo `og.controller.js`. El nombre cambió porque
 * la función principal ya no es Open Graph: ahora sirve el documento indexable
 * de cada ruta pública. El PREFIJO de las rutas sigue siendo `/og/` por
 * compatibilidad — está apuntado desde `frontend/nginx.conf` y desde links ya
 * compartidos, y renombrarlo no aporta nada funcional.
 */

const DESCRIPCION_MAX_LENGTH = 160;
const SITE_NAME = "YIMA";

function urls() {
  return {
    frontendUrl: urlFrontend(),
    backendUrl: urlBackend(),
  };
}

/**
 * Documento de "no encontrado": 404 real y `noindex`.
 *
 * Antes esta rama devolvía 200 con meta tags genéricos, y eso es un soft 404:
 * Google indexa una página vacía por cada id inexistente que alguien linkee.
 */
function responderNoEncontrado(res, frontendUrl) {
  const html = renderHtmlSeo({
    titulo: `Página no encontrada — ${SITE_NAME}`,
    descripcion: "El contenido que buscás no está disponible.",
    canonical: `${frontendUrl}/`,
    imagen: `${frontendUrl}/og-default.png`,
    noindex: true,
    cuerpo: "<h1>Página no encontrada</h1>",
  });
  res.status(404).type("html").send(html);
}

export async function servirSeoProducto(req, res, next) {
  try {
    const { frontendUrl, backendUrl } = urls();
    const id = parsearIdDeRuta(req.params.idSlug);

    // Sin id parseable no hay nada que buscar: se evita la consulta.
    if (id === null) {
      if (!esBot(req.headers["user-agent"])) return res.redirect(302, `${frontendUrl}/`);
      return responderNoEncontrado(res, frontendUrl);
    }

    const producto = await prisma.product.findUnique({
      where: { id },
      include: PRODUCT_INCLUDE,
    });

    const visible = Boolean(producto?.visibleEnCatalogo);

    // El redirect de una persona usa la URL canónica con slug, así el
    // navegador queda parado en la misma URL que declara el canonical.
    if (!esBot(req.headers["user-agent"])) {
      const destino = visible ? `${frontendUrl}${rutaProducto(producto)}` : `${frontendUrl}/`;
      return res.redirect(302, destino);
    }

    if (!visible) return responderNoEncontrado(res, frontendUrl);

    const imagen = resolverImagenOg(producto, { frontendUrl, backendUrl });
    const canonical = `${frontendUrl}${rutaProducto(producto)}`;
    const imagenes = producto.fotos.map((foto) =>
      resolverImagenOg({ id: producto.id, fotos: [foto] }, { frontendUrl, backendUrl }),
    );

    // `fraseComercial` antes que `descripcion`: es texto escrito para vender,
    // en una línea. Es exactamente lo que necesita un resultado de búsqueda.
    const descripcion = producto.fraseComercial
      ? truncarDescripcion(producto.fraseComercial, DESCRIPCION_MAX_LENGTH)
      : truncarDescripcion(producto.descripcion, DESCRIPCION_MAX_LENGTH);

    const html = renderHtmlSeo({
      titulo: `${producto.nombre} — ${SITE_NAME}`,
      descripcion,
      canonical,
      imagen,
      tipoOg: "product",
      bloquesJsonLd: [
        jsonLdProducto(producto, { frontendUrl, imagenes }),
        jsonLdBreadcrumb(producto, { frontendUrl }),
      ],
      cuerpo: cuerpoProducto(producto),
    });

    res.status(200).type("html").send(html);
  } catch (err) {
    next(err);
  }
}
