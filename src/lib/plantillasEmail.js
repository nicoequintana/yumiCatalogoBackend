import { subtotalDeItem, totalDeItems } from "./dinero.js";

/**
 * Plantillas de los mails transaccionales de órdenes.
 *
 * FUNCIONES PURAS, y eso es el punto de que este módulo exista aparte: no
 * importa red, ni Prisma, ni `process.env`. Todo lo que depende del entorno
 * (la URL del panel) entra por parámetro. Así, afirmar sobre un asunto o
 * sobre un total no requiere mockear nada.
 *
 * SOBRE EL HTML: los clientes de correo no soportan CSS moderno. Nada de
 * flexbox, grid, hojas externas ni clases — tablas con estilos inline y
 * colores hexadecimales literales. Esos hex son una COPIA MANUAL de la
 * paleta de `frontend/src/index.css`; si cambia la paleta, esto se actualiza
 * a mano (mismo criterio que `frontend/public/og-default.svg`).
 *
 * Siempre se emite `texto` además de `html`: es lo que ven los clientes que
 * no renderizan HTML, y su ausencia empeora la clasificación anti-spam.
 */

// Copia manual de los tokens de `frontend/src/index.css` (ver arriba).
const COLOR_PRIMARIO = "#9d3e1d";
const COLOR_TEXTO = "#1d1b1a";
const COLOR_TEXTO_SUAVE = "#56423c";
const COLOR_FONDO = "#fff8f5";
const COLOR_SUPERFICIE = "#ffffff";
const COLOR_BORDE = "#ddc0b8";

/**
 * Escapa lo que va a interpolarse dentro del HTML del mail.
 *
 * Todo lo que entra acá es texto que cargó una persona en el checkout
 * (nombre, notas) o el nombre de un producto. No es un vector de XSS en un
 * cliente de correo moderno, pero un `<` suelto igual rompe el markup y deja
 * el mail ilegible — y el mail interno lo lee YIMA.
 *
 * @param {unknown} valor
 * @returns {string}
 */
export function escaparHtml(valor) {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Formatea un `Decimal` como moneda argentina: punto para miles, coma para
 * decimales, siempre dos decimales.
 *
 * A mano y no con `Intl.NumberFormat`: la salida de Intl depende de la
 * versión de ICU del runtime (incluido el tipo de espacio que mete después
 * del símbolo), así que un test que la afirme pasa en una máquina y falla en
 * otra. Un mail no necesita localización configurable.
 *
 * @param {import("@prisma/client/runtime/client.js").Decimal} decimal
 * @returns {string}
 */
export function formatearMonto(decimal) {
  const [entero, decimales] = decimal.toFixed(2).split(".");
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `$${conMiles},${decimales}`;
}

/** Detalle de los items en texto plano, una línea por item. */
function itemsComoTexto(items) {
  return items
    .map(
      (item) =>
        `- ${item.nombreProducto} x${item.cantidad} — ${formatearMonto(subtotalDeItem(item))}`,
    )
    .join("\n");
}

/** Detalle de los items como filas de una tabla HTML. */
function itemsComoFilas(items) {
  return items
    .map(
      (item) => `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid ${COLOR_BORDE};color:${COLOR_TEXTO};font-size:15px;">
            ${escaparHtml(item.nombreProducto)}
          </td>
          <td style="padding:12px 0;border-bottom:1px solid ${COLOR_BORDE};color:${COLOR_TEXTO_SUAVE};font-size:15px;text-align:center;">
            x${item.cantidad}
          </td>
          <td style="padding:12px 0;border-bottom:1px solid ${COLOR_BORDE};color:${COLOR_TEXTO};font-size:15px;text-align:right;white-space:nowrap;">
            ${formatearMonto(subtotalDeItem(item))}
          </td>
        </tr>`,
    )
    .join("");
}

/** Tabla completa de items con su fila de total. */
function tablaDeItems(items) {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${itemsComoFilas(items)}
      <tr>
        <td colspan="2" style="padding:16px 0 0;color:${COLOR_TEXTO};font-size:16px;font-weight:bold;">Total</td>
        <td style="padding:16px 0 0;color:${COLOR_PRIMARIO};font-size:18px;font-weight:bold;text-align:right;white-space:nowrap;">
          ${formatearMonto(totalDeItems(items))}
        </td>
      </tr>
    </table>`;
}

/**
 * Cáscara común de los tres mails: fondo, tarjeta centrada, encabezado con la
 * marca y pie. `cuerpo` ya viene como HTML armado y escapado.
 */
function envolver({ titulo, cuerpo }) {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLOR_FONDO};padding:24px 0;margin:0;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:${COLOR_SUPERFICIE};border:1px solid ${COLOR_BORDE};border-radius:12px;">
        <tr>
          <td style="padding:32px 32px 0;">
            <p style="margin:0 0 4px;color:${COLOR_PRIMARIO};font-size:13px;letter-spacing:2px;text-transform:uppercase;font-family:Arial,Helvetica,sans-serif;">YIMA</p>
            <h1 style="margin:0 0 24px;color:${COLOR_TEXTO};font-size:24px;font-family:Arial,Helvetica,sans-serif;">${escaparHtml(titulo)}</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px;font-family:Arial,Helvetica,sans-serif;">
            ${cuerpo}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

/**
 * Mail al cliente cuando su orden entra. Confirma la recepción y deja el
 * detalle de lo que compró, con los precios snapshoteados en `ItemOrden`.
 *
 * @param {{id: number, notas: string|null, cliente: object, items: Array}} orden
 * @returns {{asunto: string, texto: string, html: string}}
 */
export function plantillaOrdenCreadaCliente(orden) {
  const asunto = `Recibimos tu pedido #${orden.id}`;

  const bloqueNotasTexto = orden.notas ? `\nNotas: ${orden.notas}\n` : "";
  const bloqueNotasHtml = orden.notas
    ? `<p style="margin:16px 0 0;color:${COLOR_TEXTO_SUAVE};font-size:14px;">
         <strong style="color:${COLOR_TEXTO};">Notas:</strong> ${escaparHtml(orden.notas)}
       </p>`
    : "";

  const texto = [
    `Hola ${orden.cliente.nombre},`,
    "",
    `Recibimos tu pedido #${orden.id}. Este es el detalle:`,
    "",
    itemsComoTexto(orden.items),
    "",
    `Total: ${formatearMonto(totalDeItems(orden.items))}`,
    bloqueNotasTexto,
    "Tu pedido está pendiente de confirmación. Te vamos a avisar por este medio",
    "en cuanto cambie de estado.",
    "",
    "Gracias por comprar en YIMA.",
  ].join("\n");

  const html = envolver({
    titulo: `Recibimos tu pedido #${orden.id}`,
    cuerpo: `
      <p style="margin:0 0 16px;color:${COLOR_TEXTO};font-size:16px;">
        Hola ${escaparHtml(orden.cliente.nombre)}, gracias por tu compra. Este es el detalle de tu pedido:
      </p>
      ${tablaDeItems(orden.items)}
      ${bloqueNotasHtml}
      <p style="margin:24px 0 0;color:${COLOR_TEXTO_SUAVE};font-size:14px;line-height:1.6;">
        Tu pedido está pendiente de confirmación. Te vamos a avisar por este medio en cuanto cambie de estado.
      </p>`,
  });

  return { asunto, texto, html };
}
