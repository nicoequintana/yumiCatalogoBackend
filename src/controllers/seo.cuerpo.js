import { escapeHtml } from "../lib/htmlSeo.js";

/**
 * El cuerpo HTML de la ficha de producto para crawlers.
 *
 * REGLA DE CLOAKING: esto tiene que espejar el contenido textual de
 * `frontend/src/components/FichaProducto.jsx`. No es un resumen ni un teaser:
 * es el mismo texto. Al agregar una sección de contenido a la ficha pública,
 * agregarla acá también. Vive en su propio archivo justamente para que esa
 * correspondencia sea fácil de auditar de un vistazo.
 *
 * Markup mínimo y semántico a propósito: un crawler lee la estructura, no el
 * estilo. Nada de clases de Tailwind.
 */

function seccion(titulo, contenidoHtml) {
  if (!contenidoHtml) return "";
  return `<section><h2>${escapeHtml(titulo)}</h2>${contenidoHtml}</section>`;
}

function parrafo(texto) {
  return texto ? `<p>${escapeHtml(texto)}</p>` : "";
}

function lista(items) {
  if (!items || items.length === 0) return "";
  return `<ul>${items.map((i) => `<li>${escapeHtml(i.texto)}</li>`).join("")}</ul>`;
}

function porTipo(listas, tipo) {
  return (listas ?? []).filter((l) => l.tipo === tipo);
}

export function cuerpoProducto(producto) {
  const partes = [
    `<h1>${escapeHtml(producto.nombre)}</h1>`,
    producto.etiqueta ? `<p>Etiqueta: ${escapeHtml(producto.etiqueta)}</p>` : "",
    parrafo(producto.fraseComercial),
    producto.categoria?.nombre ? `<p>Categoría: ${escapeHtml(producto.categoria.nombre)}</p>` : "",
    `<p>Precio: $${escapeHtml(producto.precio.toString())}</p>`,
    `<p>${producto.stock > 0 ? "Disponible" : "Sin stock"}</p>`,
    seccion("Descripción", parrafo(producto.descripcion)),
    seccion("Por qué lo vas a querer", parrafo(producto.porQueLoVasAQuerer)),
    seccion("¿Te pasa esto?", parrafo(producto.tePasaEsto)),
    seccion("Características", lista(producto.caracteristicas)),
    seccion("Beneficios", lista(porTipo(producto.listas, "BENEFICIO"))),
    seccion("Usos", lista(porTipo(producto.listas, "USO"))),
    seccion("Ideal para", lista(porTipo(producto.listas, "IDEAL_PARA"))),
    seccion("Incluye", lista(porTipo(producto.listas, "INCLUYE"))),
    seccion(
      "Especificaciones",
      (producto.especificaciones ?? []).length > 0
        ? `<dl>${producto.especificaciones
            .map((e) => `<dt>${escapeHtml(e.nombre)}</dt><dd>${escapeHtml(e.valor)}</dd>`)
            .join("")}</dl>`
        : "",
    ),
  ];

  return partes.filter(Boolean).join("\n");
}
