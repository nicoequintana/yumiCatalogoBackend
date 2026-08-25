import { subtotalDeItem, totalDeItems } from "./dinero.js";
import { ETIQUETA_ESTADO } from "./estadosOrden.js";

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
 * a mano (mismo criterio que `botDetector.js` ↔ `frontend/nginx.conf`).
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
 * Formatea un `Decimal` como moneda argentina: punto para miles, SIN decimales.
 *
 * Los montos del sistema son enteros (`Product.precio` e
 * `ItemOrden.precioUnitario` son `Decimal(10, 0)`), así que un `,00` fijo al
 * final sería ruido constante. `toFixed(0)` igual redondea por las dudas: si
 * alguna vez entra un `Decimal` con parte fraccionaria por una vía que no pasa
 * por la validación, es preferible un monto redondeado a uno con cola.
 *
 * A mano y no con `Intl.NumberFormat`: la salida de Intl depende de la
 * versión de ICU del runtime (incluido el tipo de espacio que mete después
 * del símbolo), así que un test que la afirme pasa en una máquina y falla en
 * otra. Un mail no necesita localización configurable.
 *
 * ESPEJO MANUAL de `formatPrecio` en `frontend/src/utils/formato.js` — los dos
 * repos se publican por separado. La salida difiere en un detalle a propósito:
 * el frontend separa el símbolo con un espacio (`"$ 45.000"`) y acá va pegado
 * (`"$45.000"`), como ya venía siendo. Lo que SÍ tiene que coincidir es la
 * cantidad de decimales, porque `controllers/seo.cuerpo.js` usa esta función
 * para el precio que ve un crawler y ese texto no puede diferir del que
 * muestra `FichaProducto.jsx` (regla de cloaking).
 *
 * @param {import("@prisma/client/runtime/client.js").Decimal} decimal
 * @returns {string}
 */
export function formatearMonto(decimal) {
  const entero = decimal.toFixed(0);
  const conMiles = entero.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `$${conMiles}`;
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

/**
 * Texto introductorio de cada estado. Un pedido cancelado no puede leerse con
 * el mismo tono que uno entregado, así que el copy no se genera a partir de
 * la etiqueta: se escribe uno por estado.
 */
const INTRO_POR_ESTADO = {
  PENDIENTE: "Tu pedido volvió a quedar pendiente de confirmación.",
  CONFIRMADA: "¡Confirmamos tu pedido! Ya lo estamos procesando.",
  EN_PREPARACION: "Estamos preparando tu pedido.",
  ENTREGADA: "¡Tu pedido fue entregado! Gracias por comprar en YIMA.",
  CANCELADA: "Tu pedido fue cancelado. Si no esperabas esto, escribinos y lo vemos.",
};

/**
 * Mail interno a YIMA cuando entra una orden. El asunto lleva nombre y DNI
 * para que la bandeja se pueda escanear sin abrir nada.
 *
 * `urlOrden` la arma el llamador (necesita `FRONTEND_URL`, que es entorno):
 * esta función se mantiene pura.
 *
 * @param {{id: number, notas: string|null, cliente: object, items: Array}} orden
 * @param {{urlOrden: string}} opciones
 * @returns {{asunto: string, texto: string, html: string}}
 */
export function plantillaOrdenCreadaAdmin(orden, { urlOrden }) {
  const { cliente } = orden;
  const asunto = `Nueva orden #${orden.id} — ${cliente.nombre} (DNI ${cliente.dni})`;
  const email = cliente.email ?? "—";

  const texto = [
    `Entró una orden nueva: #${orden.id}`,
    "",
    "CLIENTE",
    `Nombre: ${cliente.nombre}`,
    `DNI: ${cliente.dni}`,
    `Teléfono: ${cliente.telefono}`,
    `Email: ${email}`,
    "",
    "PEDIDO",
    itemsComoTexto(orden.items),
    "",
    `Total: ${formatearMonto(totalDeItems(orden.items))}`,
    orden.notas ? `\nNotas del cliente: ${orden.notas}` : "",
    "",
    `Ver en el panel: ${urlOrden}`,
  ].join("\n");

  const html = envolver({
    titulo: `Nueva orden #${orden.id}`,
    cuerpo: `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 24px;">
        <tr><td style="padding:2px 0;color:${COLOR_TEXTO_SUAVE};font-size:14px;width:90px;">Nombre</td><td style="padding:2px 0;color:${COLOR_TEXTO};font-size:14px;">${escaparHtml(cliente.nombre)}</td></tr>
        <tr><td style="padding:2px 0;color:${COLOR_TEXTO_SUAVE};font-size:14px;">DNI</td><td style="padding:2px 0;color:${COLOR_TEXTO};font-size:14px;">${escaparHtml(cliente.dni)}</td></tr>
        <tr><td style="padding:2px 0;color:${COLOR_TEXTO_SUAVE};font-size:14px;">Teléfono</td><td style="padding:2px 0;color:${COLOR_TEXTO};font-size:14px;">${escaparHtml(cliente.telefono)}</td></tr>
        <tr><td style="padding:2px 0;color:${COLOR_TEXTO_SUAVE};font-size:14px;">Email</td><td style="padding:2px 0;color:${COLOR_TEXTO};font-size:14px;">${escaparHtml(email)}</td></tr>
      </table>
      ${tablaDeItems(orden.items)}
      ${
        orden.notas
          ? `<p style="margin:16px 0 0;color:${COLOR_TEXTO_SUAVE};font-size:14px;"><strong style="color:${COLOR_TEXTO};">Notas del cliente:</strong> ${escaparHtml(orden.notas)}</p>`
          : ""
      }
      <p style="margin:28px 0 0;">
        <a href="${escaparHtml(urlOrden)}" style="display:inline-block;background-color:${COLOR_PRIMARIO};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:bold;">
          Ver la orden en el panel
        </a>
      </p>`,
  });

  return { asunto, texto, html };
}

/**
 * Mail al cliente cuando el admin cambia el estado de su orden.
 *
 * `orden.estado` ya es el estado NUEVO — la orden que llega acá es la que
 * devolvió la transacción del PATCH, no la anterior.
 *
 * Repite el detalle completo del pedido a propósito: el mail tiene que
 * entenderse solo, sin obligar a buscar el de la confirmación.
 *
 * @param {{id: number, estado: string, cliente: object, items: Array}} orden
 * @returns {{asunto: string, texto: string, html: string}}
 */
export function plantillaCambioEstadoCliente(orden) {
  const etiqueta = ETIQUETA_ESTADO[orden.estado] ?? orden.estado;
  const asunto = `Tu pedido #${orden.id} está ${etiqueta.toLowerCase()}`;
  const intro = INTRO_POR_ESTADO[orden.estado] ?? `Tu pedido cambió de estado: ${etiqueta}.`;

  const texto = [
    `Hola ${orden.cliente.nombre},`,
    "",
    intro,
    "",
    `Estado actual del pedido #${orden.id}: ${etiqueta}`,
    "",
    "Detalle:",
    itemsComoTexto(orden.items),
    "",
    `Total: ${formatearMonto(totalDeItems(orden.items))}`,
    "",
    "Gracias por comprar en YIMA.",
  ].join("\n");

  const html = envolver({
    titulo: `Tu pedido #${orden.id} está ${etiqueta.toLowerCase()}`,
    cuerpo: `
      <p style="margin:0 0 16px;color:${COLOR_TEXTO};font-size:16px;">
        Hola ${escaparHtml(orden.cliente.nombre)}, ${escaparHtml(intro)}
      </p>
      <p style="margin:0 0 24px;">
        <span style="display:inline-block;background-color:${COLOR_FONDO};border:1px solid ${COLOR_BORDE};color:${COLOR_PRIMARIO};padding:8px 16px;border-radius:999px;font-size:14px;font-weight:bold;">
          ${escaparHtml(etiqueta)}
        </span>
      </p>
      ${tablaDeItems(orden.items)}`,
  });

  return { asunto, texto, html };
}
