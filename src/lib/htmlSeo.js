/**
 * Arma el documento HTML que reciben los crawlers (buscadores y bots de redes
 * sociales) en las rutas `/og/*`.
 *
 * REGLA DE CLOAKING: el `cuerpo` que le pasa el llamador tiene que contener el
 * MISMO contenido textual que la SPA renderiza para una persona. Servir algo
 * distinto es cloaking y se penaliza con desindexación. Cada vez que
 * `frontend/src/components/FichaProducto.jsx` sume una sección de contenido,
 * hay que sumarla también acá.
 */

export function escapeHtml(texto) {
  if (texto === null || texto === undefined) return "";
  return String(texto)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Serializa un objeto para meterlo dentro de un `<script type="application/ld+json">`.
 *
 * El `<` se reemplaza por su escape unicode `<`. Sin eso, un producto
 * llamado `Cuchillo </script><script>alert(1)</script>` cierra la etiqueta
 * antes de tiempo y el resto se ejecuta como script: es una inyección real,
 * no un detalle de estilo. `<` es JSON válido y `JSON.parse` lo resuelve
 * al mismo carácter, así que el dato que lee Google no cambia.
 *
 * NO se puede usar `escapeHtml` acá: convertiría el `<` en `&lt;`, que dentro
 * de un bloque JSON-LD es texto literal y rompe el valor.
 */
export function serializarJsonLd(objeto) {
  return JSON.stringify(objeto).replaceAll("<", "\\u003c");
}

export function renderHtmlSeo({
  titulo,
  descripcion,
  canonical,
  imagen,
  tipoOg = "website",
  noindex = false,
  bloquesJsonLd = [],
  cuerpo = "",
}) {
  const t = escapeHtml(titulo);
  const d = escapeHtml(descripcion);
  const url = escapeHtml(canonical);
  const img = escapeHtml(imagen);

  const robots = noindex ? '    <meta name="robots" content="noindex, follow" />\n' : "";

  const scripts = bloquesJsonLd
    .map((bloque) => `    <script type="application/ld+json">${serializarJsonLd(bloque)}</script>`)
    .join("\n");

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${t}</title>
    <meta name="description" content="${d}" />
    <link rel="canonical" href="${url}" />
${robots}    <meta property="og:type" content="${escapeHtml(tipoOg)}" />
    <meta property="og:site_name" content="YIMA" />
    <meta property="og:locale" content="es_AR" />
    <meta property="og:title" content="${t}" />
    <meta property="og:description" content="${d}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:image" content="${img}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${t}" />
    <meta name="twitter:description" content="${d}" />
    <meta name="twitter:image" content="${img}" />
${scripts}
  </head>
<body>
${cuerpo}
</body>
</html>`;
}
