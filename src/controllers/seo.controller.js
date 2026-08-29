import { prisma } from "../lib/prisma.js";
import { esBot } from "../lib/botDetector.js";
import { truncarDescripcion, resolverImagenOg } from "../lib/ogMeta.js";
import { renderHtmlSeo, escapeHtml } from "../lib/htmlSeo.js";
import { jsonLdProducto, jsonLdBreadcrumb, jsonLdOrganizacion, jsonLdColeccion } from "../lib/jsonLd.js";
import { parsearIdDeRuta, rutaProducto, rutaCategoria, slugify } from "../lib/slug.js";
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

/** Cuántos productos se listan en el HTML de una página de listado. Es lo que
 * el crawler necesita para descubrir fichas; el resto lo alcanza por el
 * sitemap. */
const MAX_PRODUCTOS_LISTADO_SEO = 24;

function listaDeProductos(productos, frontendUrl) {
  if (productos.length === 0) return "<p>No hay productos para mostrar.</p>";
  return `<ul>${productos
    .map(
      (p) =>
        `<li><a href="${frontendUrl}${rutaProducto(p)}">${escapeHtml(p.nombre)}</a> — $${escapeHtml(p.precio.toString())}</li>`,
    )
    .join("")}</ul>`;
}

/**
 * Copy y estructura de la home (`frontend/src/pages/Catalogo.jsx` +
 * `frontend/src/constants/hero.js`), reescritos acá a mano.
 *
 * SYNC MANUAL entre repos, mismo criterio que `seo.cuerpo.js` ↔
 * `FichaProducto.jsx` (regla de cloaking, spec §3 de la feature de SEO): el
 * cuerpo que ve un crawler tiene que llevar el MISMO texto que ve una
 * persona, empezando por el `<h1>`. Antes de esta feature Googlebot no
 * estaba en la lista de bots, así que recibía la SPA entera y el
 * renderizador de Google veía la home real; ahora se lo desvía acá, y si
 * este texto queda desactualizado el crawler ve un `<h1>` que ya no existe
 * en la página — la forma más literal de violar esa regla. Al cambiar el
 * copy del hero o del manifiesto en el frontend, actualizar también acá.
 */
const HERO_TITULO = "Descubrí cosas que te hacen la vida más fácil.";
const HERO_PARRAFO =
  "En YIMA reunimos productos útiles, innovadores y con diseño que simplifican tu rutina y suman estilo a tu hogar, tu trabajo y tus momentos.";
// Espeja `SENALES_CONFIANZA` de `frontend/src/constants/hero.js` — el
// `texto` completo de cada señal (nunca `textoCompacto`, que es solo para la
// tarjeta angosta de móvil).
const SENALES_CONFIANZA_SEO = ["Productos seleccionados", "Útiles", "Diferentes", "Para vos o para regalar"];
const MANIFIESTO_TITULO = "El Manifiesto YIMA";
const MANIFIESTO_PARRAFO =
  "No vendemos productos: elegimos piezas que valen la pena tener cerca. Cada cosa que entra al catálogo pasó antes por la misma pregunta que te hacemos a vos — ¿esto suma o solo ocupa lugar? Encontrá lo que buscabas, y de paso, algo que no sabías que te hacía falta.";

/**
 * Techo de destacados que se listan en el HTML de la home. Espeja
 * `MAX_DESTACADOS` de `frontend/src/hooks/useDestacados.js` — mismo tope que
 * ve el carrusel real, para que el crawler no descubra (ni deje de
 * descubrir) productos que una persona no vería en esa sección.
 */
const MAX_DESTACADOS_SEO = 12;

/**
 * Piso para mostrar la sección de destacados. Espeja `MIN_DESTACADOS` de
 * `useDestacados.js`: con menos, el carrusel real se oculta entero, así que
 * el cuerpo del crawler tiene que ocultar la sección también — mostrarla
 * igual sería contenido que ninguna persona ve en la home.
 */
const MIN_DESTACADOS_SEO = 4;

function cuerpoHome(destacados, frontendUrl) {
  const senales = `<ul>${SENALES_CONFIANZA_SEO.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`;

  const seccionDestacados =
    destacados.length >= MIN_DESTACADOS_SEO
      ? `<section><h2>Hallazgos del día</h2>${listaDeProductos(destacados, frontendUrl)}</section>`
      : "";

  return [
    `<h1>${escapeHtml(HERO_TITULO)}</h1>`,
    `<p>${escapeHtml(HERO_PARRAFO)}</p>`,
    senales,
    `<p><a href="${frontendUrl}/coleccion">Ver productos</a></p>`,
    seccionDestacados,
    `<h2>${escapeHtml(MANIFIESTO_TITULO)}</h2>`,
    `<p>${escapeHtml(MANIFIESTO_PARRAFO)}</p>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function servirSeoHome(req, res, next) {
  try {
    const { frontendUrl } = urls();
    if (!esBot(req.headers["user-agent"])) return res.redirect(302, `${frontendUrl}/`);

    // Mismo filtro y mismo orden que ve una persona: `useDestacados.js` pide
    // `destacado=1` contra `GET /products`, cuyo default de orden
    // (`recientes`) es `[{createdAt:"desc"},{id:"desc"}]` — ver
    // `ORDENES_LISTADO` en `products.controller.js`.
    const destacados = await prisma.product.findMany({
      where: { destacado: true, visibleEnCatalogo: true, stock: { gt: 0 } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_DESTACADOS_SEO,
      select: { id: true, nombre: true, precio: true },
    });

    const html = renderHtmlSeo({
      titulo: `${SITE_NAME} — Productos útiles, innovadores y con diseño`,
      descripcion:
        "Productos útiles, innovadores y con diseño que simplifican tu rutina y suman estilo a tu hogar, tu trabajo y tus momentos.",
      canonical: `${frontendUrl}/`,
      imagen: `${frontendUrl}/og-default.png`,
      bloquesJsonLd: [jsonLdOrganizacion({ frontendUrl })],
      cuerpo: cuerpoHome(destacados, frontendUrl),
    });

    res.status(200).type("html").send(html);
  } catch (err) {
    next(err);
  }
}

/**
 * Sirve `/coleccion` y `/coleccion/categoria/:slug` con el mismo código: la
 * única diferencia es el filtro y los textos. Solo necesita `res` — el
 * llamador ya resolvió `categoria` y maneja sus propios errores.
 */
async function servirListado(res, { categoria }) {
  const { frontendUrl } = urls();

  // `rutaCategoria` puede devolver `null` si el nombre de la categoría no
  // deja slug (símbolos, vacío) — mismo caso límite que documenta
  // `Coleccion.jsx` del frontend (`rutaCanonica`). No alcanzable hoy: para
  // llegar hasta acá la categoría ya matcheó un slug no vacío contra la ruta
  // pedida. Se maneja igual que el frontend, cayendo a `/coleccion` sin
  // filtro en vez de armar una URL rota.
  const ruta = categoria ? (rutaCategoria(categoria) ?? "/coleccion") : "/coleccion";
  const titulo = categoria ? `${categoria.nombre} — ${SITE_NAME}` : `Todos los productos — ${SITE_NAME}`;
  const descripcion = categoria
    ? `Productos de ${categoria.nombre} en ${SITE_NAME}: útiles, innovadores y con diseño.`
    : `Explorá el catálogo completo de ${SITE_NAME}: filtrá por categoría y precio para encontrar lo que buscás.`;

  const productos = await prisma.product.findMany({
    where: {
      visibleEnCatalogo: true,
      stock: { gt: 0 },
      ...(categoria ? { categoriaId: categoria.id } : {}),
    },
    // Mismo orden que ve una persona en `/coleccion`: el default
    // `merchandising` de `GET /products` (`ORDENES_LISTADO` en
    // `products.controller.js`). Era `merchandising` hasta el 29/08/2026, con
    // un `orden` manual que se eliminó por no usarse — con
    // `{ id: "asc" }` el crawler vería los más VIEJOS primero mientras la
    // persona ve los más nuevos.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MAX_PRODUCTOS_LISTADO_SEO,
    select: { id: true, nombre: true, precio: true },
  });

  const canonical = `${frontendUrl}${ruta}`;

  const html = renderHtmlSeo({
    titulo,
    descripcion,
    canonical,
    imagen: `${frontendUrl}/og-default.png`,
    bloquesJsonLd: [
      jsonLdColeccion({
        titulo: categoria ? categoria.nombre : "Todos los productos",
        url: canonical,
        productos,
        frontendUrl,
      }),
    ],
    cuerpo: `<h1>${escapeHtml(categoria ? categoria.nombre : "Todos los productos")}</h1>${listaDeProductos(productos, frontendUrl)}`,
  });

  res.status(200).type("html").send(html);
}

export async function servirSeoColeccion(req, res, next) {
  try {
    const { frontendUrl } = urls();
    if (!esBot(req.headers["user-agent"])) return res.redirect(302, `${frontendUrl}/coleccion`);
    await servirListado(res, { categoria: null });
  } catch (err) {
    next(err);
  }
}

export async function servirSeoCategoria(req, res, next) {
  try {
    const { frontendUrl } = urls();
    const slug = req.params.slug;

    if (!esBot(req.headers["user-agent"])) {
      return res.redirect(302, `${frontendUrl}/coleccion/categoria/${slug}`);
    }

    // No hay columna `slug` en la base: se traen las categorías y se compara
    // el slug derivado de cada una. Son pocas decenas de filas — un
    // `findMany` + filtro en memoria es más simple y más correcto que
    // intentar reconstruir el nombre desde el slug, que no es reversible
    // (tildes y símbolos se pierden al slugificar). Mismo criterio, mismo
    // resultado, que `Coleccion.jsx` en el frontend (`categoriaDeRuta`): las
    // dos comparan `slugify(c.nombre) === slug` contra la lista completa de
    // categorías, así que resuelven la misma categoría para el mismo slug.
    const categorias = await prisma.categoria.findMany({ select: { id: true, nombre: true } });
    const categoria = categorias.find((c) => slugify(c.nombre) === slug) ?? null;

    if (!categoria) return responderNoEncontrado(res, frontendUrl);

    await servirListado(res, { categoria });
  } catch (err) {
    next(err);
  }
}
