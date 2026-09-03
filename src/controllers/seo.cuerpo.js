import { escapeHtml } from "../lib/htmlSeo.js";
import { Decimal } from "@prisma/client/runtime/client.js";
import { formatearMonto } from "../lib/plantillasEmail.js";

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

/**
 * Normaliza a `Decimal` lo que le llegue.
 *
 * `formatearMonto` llama a `.toFixed(0)`, que un string no tiene. El precio
 * efectivo puede viajar como Decimal (desde el controller) o como string
 * (desde un mapper ya serializado), y el HTML del crawler no puede explotar
 * según por dónde entre.
 */
function aDecimal(valor) {
  return valor instanceof Decimal ? valor : new Decimal(valor);
}

/**
 * @param {object} producto
 * @param {object} [opciones]
 * @param {{porcentaje: number, precioEfectivo: string}|null} [opciones.descuento]
 */
export function cuerpoProducto(producto, { descuento = null } = {}) {
  const partes = [
    `<h1>${escapeHtml(producto.nombre)}</h1>`,
    producto.etiqueta ? `<p>Etiqueta: ${escapeHtml(producto.etiqueta)}</p>` : "",
    parrafo(producto.fraseComercial),
    producto.categoria?.nombre ? `<p>Categoría: ${escapeHtml(producto.categoria.nombre)}</p>` : "",
    // `formatearMonto` (`lib/plantillasEmail.js`) — la misma casa de la
    // aritmética con `Decimal` que usan los mails de órdenes — para que el
    // precio que ve el crawler coincida con el que muestra `FichaProducto.jsx`
    // ($45.000,00), no con el string crudo del `Decimal` ($45000.00).
    //
    // ⚠️ REGLA DE CLOAKING. Con una promoción activa la ficha muestra el precio
    // tachado, el efectivo y el porcentaje: el crawler tiene que ver LO MISMO.
    // Servirle solo el de lista sería mostrarle al buscador un precio que en la
    // página no existe — y servirle solo el efectivo, ocultarle que hay oferta.
    descuento
      ? `<p>Precio: <s>${escapeHtml(formatearMonto(producto.precio))}</s> ` +
        // `aDecimal` y no el valor crudo: `formatearMonto` llama a `.toFixed(0)`,
        // que un string no tiene. La primera versión pasó toda la suite en verde
        // y tiró un 500 en el endpoint real por exactamente esto.
        `${escapeHtml(formatearMonto(aDecimal(descuento.precioEfectivo)))} ` +
        `(${descuento.porcentaje}% OFF)</p>`
      : `<p>Precio: ${escapeHtml(formatearMonto(producto.precio))}</p>`,
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
