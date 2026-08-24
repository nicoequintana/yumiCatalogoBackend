/**
 * Slugs de URL para el catálogo público.
 *
 * SYNC MANUAL con `frontend/src/utils/slug.js`: los dos repos se publican por
 * separado (ver `docs/deploy/publicar-a-repos-separados.md`), así que no hay
 * forma de compartir el módulo. Mismo trade-off documentado que
 * `botDetector.js` <-> `frontend/nginx.conf`. Las dos copias tienen el mismo
 * set de casos en sus tests: al tocar una, tocar la otra.
 *
 * El slug es DERIVADO del nombre, nunca persistido: no hay columna `slug` en
 * el schema. La clave real sigue siendo el `id`, que va como prefijo de la
 * ruta — por eso `/producto/123` pelado sigue resolviendo y ningún link ya
 * compartido se rompe.
 */

/** Tope de largo del slug. No es un límite técnico: es para que la URL siga
 * siendo legible en un chat o en un resultado de búsqueda. */
const LARGO_MAX_SLUG = 80;

export function slugify(texto) {
  if (!texto) return "";

  return String(texto)
    // `NFD` separa cada letra acentuada en letra base + marca diacrítica, y el
    // rango ̀-ͯ borra esas marcas. Es lo que convierte "á" en "a"
    // sin una tabla de reemplazos a mano.
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LARGO_MAX_SLUG)
    // El `slice` puede haber cortado justo sobre un guion: se limpia después
    // de recortar, no antes.
    .replace(/-+$/g, "");
}

export function parsearIdDeRuta(param) {
  if (!param) return null;

  // Solo dígitos al inicio, y lo que siga tiene que arrancar con guion. Así
  // "12.5" no pasa como 12: el punto no es un guion.
  const match = /^(\d+)(?:-|$)/.exec(String(param));
  if (!match) return null;

  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function rutaProducto(producto) {
  const slug = slugify(producto.nombre);
  return slug ? `/producto/${producto.id}-${slug}` : `/producto/${producto.id}`;
}

/**
 * A diferencia de `rutaProducto`, esta ruta NO lleva el `id` como prefijo
 * (`/coleccion/categoria/:slugCategoria`, sin componente numérico) — así que
 * no hay un fallback tipo "sin slug, mostrar el id pelado" al que recurrir.
 * Si el nombre no deja slug (todo símbolos, o vacío), no hay forma de armar
 * una ruta que distinga esa categoría de otra en la misma situación, y
 * `/coleccion/categoria/` a secas sería una URL ambigua y rota. Por eso acá
 * el contrato es: sin slug, no hay ruta — se devuelve `null` y el llamador
 * decide qué hacer (omitir la entrada, típicamente).
 */
export function rutaCategoria(categoria) {
  const slug = slugify(categoria?.nombre);
  return slug ? `/coleccion/categoria/${slug}` : null;
}
