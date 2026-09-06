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

/**
 * Una SUBsección (`<h3>`), para lo que en la ficha cuelga de otro título.
 * Características y Especificaciones técnicas no son secciones sueltas: viven
 * dentro de "Ficha técnica".
 */
function subseccion(titulo, contenidoHtml) {
  if (!contenidoHtml) return "";
  return `<h3>${escapeHtml(titulo)}</h3>${contenidoHtml}`;
}

/**
 * El umbral de "últimas unidades". Es la SEXTA copia del 3 que el censo de
 * sincronizaciones de `CLAUDE.md` ya registra, y acá tiene que coincidir con
 * `FichaProducto.jsx` o el bot lee un estado de stock que la página no muestra.
 */
const STOCK_BAJO = 3;

/**
 * La línea de stock, espejando `FichaProducto.jsx`: "Agotado" en cero,
 * "Últimos N" hasta el umbral, y NADA con stock holgado — la ficha tampoco
 * muestra nada ahí. Decía "Disponible"/"Sin stock", dos textos que no existen
 * en la página.
 */
function lineaStock(stock) {
  if (stock === 0) return "<p>Agotado</p>";
  if (stock > 0 && stock <= STOCK_BAJO) return `<p>Últimos ${stock}</p>`;
  return "";
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
    // La etiqueta PELADA: la ficha la muestra con `<Badge>`, que pinta el texto
    // solo. El prefijo "Etiqueta: " no existe en la página.
    producto.etiqueta ? `<p>${escapeHtml(producto.etiqueta)}</p>` : "",
    parrafo(producto.fraseComercial),
    // ⚠️ NO va la categoría. La ficha no la muestra en ningún lado —no hay
    // migas de pan ni línea de categoría—, así que emitirla acá era contenido
    // EXCLUSIVO del bot: la definición de cloaking. Se sirvió así hasta el
    // 06/09/2026. La señal de categoría le llega a Google igual, por el
    // `jsonLdBreadcrumb` del `<head>`, que no es contenido visible.

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
    lineaStock(producto.stock),
    // La descripción va SIN título: en la ficha cuelga suelta debajo del
    // precio. El `<h2>Descripción</h2>` que había acá no existe en la página.
    parrafo(producto.descripcion),
    // Los dos títulos, con sus signos y con el texto EXACTO de la ficha. El
    // segundo se llamaba "¿Te pasa esto?" acá y "¿Qué problema resuelve?" en
    // la página; el nombre del campo (`tePasaEsto`) es el que quedó viejo.
    // Los beneficios y los usos NO tienen título propio: cuelgan de estas dos
    // secciones, igual que en la ficha.
    seccion(
      "¿Por qué lo vas a querer?",
      parrafo(producto.porQueLoVasAQuerer) +
        // `.slice(0, 3)` como `FichaProducto.jsx`: la página muestra tres. Con
        // los cinco, el bot leía contenido que el visitante no ve.
        lista(porTipo(producto.listas, "BENEFICIO").slice(0, 3)),
    ),
    seccion(
      "¿Qué problema resuelve?",
      parrafo(producto.tePasaEsto) + lista(porTipo(producto.listas, "USO")),
    ),
    seccion("Ideal para", lista(porTipo(producto.listas, "IDEAL_PARA"))),
    seccion("Incluye", lista(porTipo(producto.listas, "INCLUYE"))),
    // Características y Especificaciones técnicas son SUBsecciones de "Ficha
    // técnica", no dos secciones hermanas: es la jerarquía de la ficha.
    seccion(
      "Ficha técnica",
      subseccion("Características", lista(producto.caracteristicas)) +
        subseccion(
          "Especificaciones técnicas",
          (producto.especificaciones ?? []).length > 0
            ? `<dl>${producto.especificaciones
                .map((e) => `<dt>${escapeHtml(e.nombre)}</dt><dd>${escapeHtml(e.valor)}</dd>`)
                .join("")}</dl>`
            : "",
        ),
    ),
    // Los relacionados cierran la ficha y son links internos reales. Omitirlos
    // le servía al bot una página más pobre que la que ve una persona.
    seccion("También te puede interesar", lista((producto.relacionados ?? []).map(
      (r) => ({ texto: r.nombre }),
    ))),
  ];

  return partes.filter(Boolean).join("\n");
}
