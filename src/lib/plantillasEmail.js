import { Decimal } from "@prisma/client/runtime/client.js";
import { subtotalDeItem, totalDeItems } from "./dinero.js";
import { ETIQUETA_ESTADO } from "./estadosOrden.js";
// El desfase de -3 vive en `lib/horarioArgentino.js` desde que la analytics del
// admin pasó a necesitar el mismo concepto de "día". Escribirlo de nuevo acá
// sería tener dos definiciones de día que se pueden desincronizar sin que nada
// falle — ver "Módulos compartidos" en CLAUDE.md.
import { enHorarioArgentino } from "./horarioArgentino.js";

/**
 * Plantillas de los mails transaccionales de órdenes.
 *
 * FUNCIONES PURAS, y eso es el punto de que este módulo exista aparte: no
 * importa red, ni Prisma, ni `process.env`. Todo lo que depende del entorno
 * (la URL del panel, la del sitio público de donde sale el logo) entra por
 * parámetro. Así, afirmar sobre un asunto o sobre un total no requiere
 * mockear nada.
 *
 * SOBRE EL HTML: los clientes de correo no soportan CSS moderno. Nada de
 * flexbox, grid, hojas externas ni clases de utilidad — tablas anidadas con
 * estilos inline y colores hexadecimales literales. Esos hex son una COPIA
 * MANUAL de la paleta de `frontend/src/index.css`; si cambia la paleta, esto
 * se actualiza a mano (mismo criterio que `botDetector.js` ↔ `nginx.conf`).
 *
 * Cada mail es un DOCUMENTO HTML COMPLETO, no un fragmento. Tres cosas
 * dependen de que lo sea, y las tres se pierden en silencio si alguien lo
 * recorta a un `<table>` suelto:
 *
 * - `<meta name="color-scheme" content="light">`, que es lo único que frena
 *   la inversión automática de Gmail y Apple Mail en modo oscuro. Sin eso el
 *   crema de la marca sale gris sucio y el terracota pierde contraste.
 * - El `<style>` del `<head>` con la única media query, que achica los
 *   márgenes en pantalla angosta. Es progresivo: los estilos inline ya dejan
 *   el mail legible en el cliente que descarta el bloque.
 * - `<html lang="es">`, que es lo que hace que un lector de pantalla lo lea
 *   en castellano.
 *
 * Siempre se emite `texto` además de `html`: es lo que ven los clientes que
 * no renderizan HTML, y su ausencia empeora la clasificación anti-spam.
 */

// Copia manual de los tokens de `frontend/src/index.css` (ver arriba).
const COLOR_PRIMARIO = "#9d3e1d";
const COLOR_TEXTO = "#1d1b1a";
const COLOR_TEXTO_SUAVE = "#56423c";
const COLOR_TEXTO_TENUE = "#8a726b";
const COLOR_FONDO = "#fff8f5";
const COLOR_SUPERFICIE = "#ffffff";
const COLOR_PANEL = "#f9f2ef";
const COLOR_BORDE = "#ddc0b8";
const COLOR_BORDE_SUAVE = "#ede7e4";
const COLOR_ACENTO_DORADO = "#e9c46a";

/**
 * Pila tipográfica del mail. No hay webfont: un `@font-face` remoto lo
 * descarta la mayoría de los clientes y el `<link>` a Google Fonts no llega a
 * ninguno. Lo mejor disponible es pedir la tipografía nativa de cada sistema
 * —San Francisco en Apple Mail, Segoe UI en Outlook de Windows, Roboto en
 * Gmail de Android— y caer a Arial donde no haya ninguna.
 */
const FUENTE = "-apple-system,'Segoe UI',Roboto,Arial,Helvetica,sans-serif";

/** Nombre del archivo del logo dentro del sitio público (`frontend/public/`). */
const ARCHIVO_LOGO = "logo-yima-160.png";

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

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

/**
 * `"26 de agosto de 2026"`, en hora de Argentina.
 *
 * Devuelve `null` —y no un texto de relleno— cuando la fecha falta o no se
 * puede leer: quien la muestra omite el bloque entero en vez de imprimir un
 * "Invalid Date" en el comprobante de un cliente.
 *
 * @param {Date|string|number|null|undefined} valor
 * @returns {string|null}
 */
export function formatearFecha(valor) {
  const fecha = enHorarioArgentino(valor);
  if (fecha === null) return null;
  return `${fecha.getUTCDate()} de ${MESES[fecha.getUTCMonth()]} de ${fecha.getUTCFullYear()}`;
}

/**
 * `"26 de agosto de 2026, 19:42"`, en hora de Argentina. Mismo contrato de
 * `null` que `formatearFecha`.
 *
 * @param {Date|string|number|null|undefined} valor
 * @returns {string|null}
 */
export function formatearFechaHora(valor) {
  const fecha = enHorarioArgentino(valor);
  if (fecha === null) return null;
  const hora = String(fecha.getUTCHours()).padStart(2, "0");
  const minutos = String(fecha.getUTCMinutes()).padStart(2, "0");
  return `${formatearFecha(valor)}, ${hora}:${minutos}`;
}

/** Unidades totales del pedido, para el resumen del encabezado interno. */
function unidadesDe(items) {
  return (items ?? []).reduce((total, item) => total + item.cantidad, 0);
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
          <td style="padding:14px 12px 14px 0;border-bottom:1px solid ${COLOR_BORDE_SUAVE};color:${COLOR_TEXTO};font-size:15px;line-height:1.4;">
            ${escaparHtml(item.nombreProducto)}
            <span style="display:block;color:${COLOR_TEXTO_SUAVE};font-size:13px;padding-top:3px;">${formatearMonto(new Decimal(item.precioUnitario))} c/u</span>
          </td>
          <td style="padding:14px 0;border-bottom:1px solid ${COLOR_BORDE_SUAVE};color:${COLOR_TEXTO_SUAVE};font-size:15px;text-align:center;">
            ${item.cantidad}
          </td>
          <td style="padding:14px 0 14px 12px;border-bottom:1px solid ${COLOR_BORDE_SUAVE};color:${COLOR_TEXTO};font-size:15px;text-align:right;white-space:nowrap;">
            ${formatearMonto(subtotalDeItem(item))}
          </td>
        </tr>`,
    )
    .join("");
}

/**
 * Tabla de items con encabezados de columna y el total en su propio panel.
 *
 * El total va SEPARADO de la tabla, en una superficie tenue, y no como una
 * fila más: es el dato que se busca primero al abrir el mail y una fila al pie
 * de una lista larga se pierde entre los subtotales.
 */
function detalleDelPedido(items) {
  const encabezado = (texto, alineacion) => `
          <td style="padding:0 0 8px;border-bottom:2px solid ${COLOR_BORDE};color:${COLOR_TEXTO_SUAVE};font-size:11px;letter-spacing:0.6px;text-transform:uppercase;text-align:${alineacion};">
            ${texto}
          </td>`;

  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          ${encabezado("Producto", "left")}
          ${encabezado("Cant.", "center")}
          ${encabezado("Subtotal", "right")}
        </tr>
        ${itemsComoFilas(items)}
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0 0;background-color:${COLOR_PANEL};border-radius:10px;">
        <tr>
          <td style="padding:16px 20px;color:${COLOR_TEXTO};font-size:15px;font-weight:bold;">Total</td>
          <td class="yima-total" style="padding:16px 20px;color:${COLOR_PRIMARIO};font-size:22px;font-weight:bold;text-align:right;white-space:nowrap;">
            ${formatearMonto(totalDeItems(items))}
          </td>
        </tr>
      </table>`;
}

/** Rótulo de sección: el mismo escalón tipográfico en los tres mails. */
function rotuloSeccion(texto) {
  return `<p style="margin:0 0 10px;color:${COLOR_TEXTO_SUAVE};font-size:11px;letter-spacing:1.6px;text-transform:uppercase;font-weight:bold;">${texto}</p>`;
}

/** Nota del cliente, destacada con un filete dorado en vez de un párrafo más. */
function bloqueNotas(titulo, notas) {
  if (!notas) return "";
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:20px 0 0;">
        <tr>
          <td style="padding:14px 18px;background-color:${COLOR_FONDO};border-left:3px solid ${COLOR_ACENTO_DORADO};border-radius:0 8px 8px 0;color:${COLOR_TEXTO_SUAVE};font-size:14px;line-height:1.6;">
            <strong style="color:${COLOR_TEXTO};">${titulo}:</strong> ${escaparHtml(notas)}
          </td>
        </tr>
      </table>`;
}

/**
 * Wordmark del encabezado.
 *
 * Se sirve por URL absoluta desde el sitio público. La alternativa era
 * incrustarlo como adjunto embebido (`cid:`), que se ve siempre pero suma
 * ~42 kB a cada mail y obliga a que estas funciones dejen de ser puras para
 * emitir el adjunto junto con el HTML.
 *
 * El costo de la URL es que Outlook —y cualquier cliente con las imágenes
 * bloqueadas— no la va a descargar. Por eso el `alt` no es una etiqueta
 * suelta: va estilado como wordmark (terracota, mayúsculas espaciadas), así
 * el encabezado sigue diciendo la marca aunque no baje ni un byte de imagen.
 *
 * Sin `urlSitio` no se emite ninguna imagen: un `src` vacío pinta el ícono de
 * imagen rota en todos los clientes, que es peor que el texto. En producción
 * el caso no es alcanzable —`FRONTEND_URL` está en `VARIABLES_REQUERIDAS` y
 * el server no arranca sin ella—, pero estas funciones se llaman también
 * desde los tests sin entorno.
 */
function bloqueLogo(urlSitio) {
  if (!urlSitio) {
    return `<p style="margin:0;color:${COLOR_PRIMARIO};font-family:${FUENTE};font-size:22px;font-weight:bold;letter-spacing:4px;">YIMA</p>`;
  }

  const src = `${escaparHtml(urlSitio)}/${ARCHIVO_LOGO}`;
  return `<img src="${src}" width="112" height="38" alt="YIMA" style="display:block;border:0;color:${COLOR_PRIMARIO};font-family:${FUENTE};font-size:22px;font-weight:bold;letter-spacing:4px;">`;
}

/**
 * Texto de vista previa: lo que el cliente de correo muestra en la bandeja
 * debajo del asunto.
 *
 * Sin esto, Gmail agarra la primera línea visible del cuerpo — que suele ser
 * el saludo — y desperdicia el único renglón que decide si el mail se abre.
 *
 * Los caracteres invisibles del final (espacio numérico + marca de orden de
 * bytes, repetidos) empujan fuera de ese renglón el texto que el cliente
 * agregaría a continuación; es la técnica estándar y no hay una más limpia.
 */
function preheader(texto) {
  const relleno = "&#8199;&#65279;&nbsp;".repeat(20);
  return `<div style="display:none;font-size:1px;color:${COLOR_FONDO};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escaparHtml(texto)}${relleno}</div>`;
}

/**
 * Cáscara común de los tres mails: documento completo, logo, tarjeta con banda
 * de encabezado y pie fuera de la tarjeta.
 *
 * `cuerpo` y `pie` ya vienen como HTML armado y escapado.
 *
 * La banda de encabezado (rótulo + título + línea de contexto) es lo que hace
 * que los tres mails se lean como de la misma casa aunque digan cosas
 * distintas: quien recibe uno reconoce dónde mirar en los otros dos.
 */
function envolver({ vistaPrevia, rotulo, titulo, contexto, cuerpo, pie, urlSitio }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escaparHtml(titulo)}</title>
<style>
  @media only screen and (max-width:600px) {
    .yima-pad { padding-left:20px !important; padding-right:20px !important; }
    .yima-titulo { font-size:21px !important; }
    .yima-total { font-size:19px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${COLOR_FONDO};">
${preheader(vistaPrevia)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLOR_FONDO};padding:28px 12px;margin:0;border-collapse:collapse;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-collapse:collapse;">
        <tr>
          <td align="center" style="padding:0 0 22px;">
            ${bloqueLogo(urlSitio)}
          </td>
        </tr>
        <tr>
          <td style="background-color:${COLOR_SUPERFICIE};border:1px solid ${COLOR_BORDE};border-radius:14px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr>
                <td class="yima-pad" style="background-color:${COLOR_PANEL};border-bottom:1px solid ${COLOR_BORDE};border-radius:13px 13px 0 0;padding:26px 32px;font-family:${FUENTE};">
                  <p style="margin:0 0 6px;color:${COLOR_PRIMARIO};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;">${escaparHtml(rotulo)}</p>
                  <h1 class="yima-titulo" style="margin:0 0 8px;color:${COLOR_TEXTO};font-size:25px;line-height:1.25;font-weight:600;">${escaparHtml(titulo)}</h1>
                  <p style="margin:0;color:${COLOR_TEXTO_SUAVE};font-size:14px;">${contexto}</p>
                </td>
              </tr>
              <tr>
                <td class="yima-pad" style="padding:28px 32px 32px;font-family:${FUENTE};">
                  ${cuerpo}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:22px 24px 0;text-align:center;font-family:${FUENTE};">
            ${pie}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** Pie de los dos mails al cliente. */
function pieCliente(urlSitio) {
  const enlace = urlSitio
    ? `<a href="${escaparHtml(urlSitio)}" style="color:${COLOR_PRIMARIO};text-decoration:none;">yima-productos.com</a>`
    : "YIMA";

  return `
        <p style="margin:0 0 6px;color:${COLOR_TEXTO_SUAVE};font-size:13px;line-height:1.6;">
          ¿Alguna duda con tu pedido? Respondé este correo y te contestamos.
        </p>
        <p style="margin:0;color:${COLOR_TEXTO_TENUE};font-size:12px;line-height:1.6;">
          Recibís este correo porque hiciste un pedido en ${enlace}
        </p>`;
}

/** Línea de contexto de la banda: número de pedido y, si se conoce, fecha. */
function contextoDePedido(id, fecha) {
  const numero = `Pedido <strong style="color:${COLOR_TEXTO};">#${id}</strong>`;
  return fecha ? `${numero} &nbsp;·&nbsp; ${escaparHtml(fecha)}` : numero;
}

/**
 * Mail al cliente cuando su orden entra. Confirma la recepción y deja el
 * detalle de lo que compró, con los precios snapshoteados en `ItemOrden`.
 *
 * @param {{id: number, notas: string|null, createdAt?: Date, cliente: object, items: Array}} orden
 * @param {{urlSitio?: string}} [opciones]
 * @returns {{asunto: string, texto: string, html: string}}
 */
export function plantillaOrdenCreadaCliente(orden, { urlSitio } = {}) {
  const asunto = `Recibimos tu pedido #${orden.id}`;
  const total = formatearMonto(totalDeItems(orden.items));

  const bloqueNotasTexto = orden.notas ? `\nNotas: ${orden.notas}\n` : "";

  const texto = [
    `Hola ${orden.cliente.nombre},`,
    "",
    `Recibimos tu pedido #${orden.id}. Este es el detalle:`,
    "",
    itemsComoTexto(orden.items),
    "",
    `Total: ${total}`,
    bloqueNotasTexto,
    "Tu pedido está pendiente de confirmación. Te vamos a avisar por este medio",
    "en cuanto cambie de estado.",
    "",
    "Gracias por comprar en YIMA.",
  ].join("\n");

  const html = envolver({
    urlSitio,
    vistaPrevia: `Total ${total} · te avisamos apenas lo confirmemos.`,
    rotulo: "Pedido recibido",
    titulo: `Gracias por tu compra, ${orden.cliente.nombre}`,
    contexto: contextoDePedido(orden.id, formatearFecha(orden.createdAt)),
    cuerpo: `
              <p style="margin:0 0 26px;color:${COLOR_TEXTO};font-size:16px;line-height:1.6;">
                Ya tenemos tu pedido. Está pendiente de confirmación y te vamos a avisar por este mismo medio en cuanto cambie de estado.
              </p>
              ${rotuloSeccion("Detalle del pedido")}
              ${detalleDelPedido(orden.items)}
              ${bloqueNotas("Tus notas", orden.notas)}`,
    pie: pieCliente(urlSitio),
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
  EN_PREPARACION: "¡Confirmamos tu pedido! Ya lo estamos preparando.",
  ENTREGADA: "¡Tu pedido fue entregado! Gracias por comprar en YIMA.",
  CANCELADA: "Tu pedido fue cancelado. Si no esperabas esto, escribinos y lo vemos.",
};

/**
 * Título de la banda por estado. Es lo primero que se lee, así que dice lo que
 * pasó en vez de repetir la etiqueta del sistema.
 */
const TITULO_POR_ESTADO = {
  PENDIENTE: "Tu pedido volvió a quedar pendiente",
  EN_PREPARACION: "Confirmamos tu pedido",
  ENTREGADA: "Tu pedido fue entregado",
  CANCELADA: "Tu pedido fue cancelado",
};

/**
 * Color del chip de estado. Salen todos de los tokens de la paleta: los dos
 * estados "todo bien" usan el verde musgo, el intermedio el dorado y la
 * cancelación el rojo de error. Que CANCELADA no comparta color con ENTREGADA
 * es el punto del chip — de un vistazo tiene que distinguirse un pedido que
 * llegó de uno que se cayó.
 */
const ESTILO_ESTADO = {
  PENDIENTE: { fondo: "#ede7e4", texto: COLOR_TEXTO_SUAVE },
  EN_PREPARACION: { fondo: "#e9c46a", texto: "#473600" },
  ENTREGADA: { fondo: "#586330", texto: "#ffffff" },
  CANCELADA: { fondo: "#ffdad6", texto: "#93000a" },
};

/** Los tres pasos del recorrido normal de un pedido, en orden. */
const PASOS = ["Recibido", "En preparación", "Entregado"];

/**
 * Cuántos pasos lleva completados cada estado. `CANCELADA` no está: una orden
 * cancelada no está "a un paso de entregarse", y dibujarle la barra
 * sugeriría que el pedido sigue en curso.
 */
const PASO_DE_ESTADO = {
  PENDIENTE: 1,
  EN_PREPARACION: 2,
  ENTREGADA: 3,
};

/** Chip con la etiqueta del estado, en su color. */
function chipEstado(estado, etiqueta) {
  const estilo = ESTILO_ESTADO[estado] ?? ESTILO_ESTADO.PENDIENTE;
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 26px;">
        <tr>
          <td style="border-radius:999px;padding:9px 20px;background-color:${estilo.fondo};color:${estilo.texto};font-size:14px;font-weight:bold;letter-spacing:0.3px;">
            ${escaparHtml(etiqueta)}
          </td>
        </tr>
      </table>`;
}

/**
 * Barra de avance de los pasos de `PASOS`.
 *
 * Son celdas de tabla con `bgcolor` y 4 px de alto, no divs ni bordes: es la
 * única forma que renderiza igual en Outlook de escritorio, que ignora tanto
 * `border-radius` como cualquier cosa parecida a un elemento vacío con altura
 * por CSS. El `font-size:0` y el `&nbsp;` son lo que evita que la celda
 * colapse en los clientes que descartan el atributo `height`.
 *
 * Devuelve string vacío para un estado sin recorrido (CANCELADA).
 */
function barraProgreso(estado) {
  const completados = PASO_DE_ESTADO[estado];
  if (!completados) return "";

  // Derivado de `PASOS.length`, no hardcodeado: así la cantidad de pasos y el
  // ancho de cada celda no se pueden desincronizar si el recorrido cambia.
  const anchoPaso = `${Math.floor(100 / PASOS.length)}%`;

  const barras = PASOS.map((_, indice) => {
    const relleno = indice < completados ? COLOR_PRIMARIO : COLOR_BORDE;
    const margen =
      indice === 0 ? "0 4px 0 0" : indice === PASOS.length - 1 ? "0 0 0 4px" : "0 4px";
    return `
          <td width="${anchoPaso}" style="padding:${margen};">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
              <tr><td height="4" bgcolor="${relleno}" style="background-color:${relleno};border-radius:2px;font-size:0;line-height:4px;">&nbsp;</td></tr>
            </table>
          </td>`;
  }).join("");

  const rotulos = PASOS.map((paso, indice) => {
    const actual = indice === completados - 1;
    const color = actual ? COLOR_PRIMARIO : indice < completados ? COLOR_TEXTO_SUAVE : COLOR_TEXTO_TENUE;
    const peso = actual ? "font-weight:bold;" : "";
    const margen =
      indice === 0 ? "8px 4px 0 0" : indice === PASOS.length - 1 ? "8px 0 0 4px" : "8px 4px 0";
    return `<td style="padding:${margen};color:${color};font-size:11px;${peso}">${paso}</td>`;
  }).join("");

  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 28px;">
        <tr>${barras}</tr>
        <tr>${rotulos}</tr>
      </table>`;
}

/**
 * Mail interno a YIMA cuando entra una orden. El asunto lleva nombre y DNI
 * para que la bandeja se pueda escanear sin abrir nada.
 *
 * `urlOrden` la arma el llamador (necesita `FRONTEND_URL`, que es entorno):
 * esta función se mantiene pura.
 *
 * El teléfono y el email van como enlaces `tel:` y `mailto:` — desde el
 * celular, contactar al cliente pasa a ser un toque en vez de copiar a mano un
 * número de una tabla.
 *
 * @param {{id: number, notas: string|null, createdAt?: Date, cliente: object, items: Array}} orden
 * @param {{urlOrden: string, urlSitio?: string}} opciones
 * @returns {{asunto: string, texto: string, html: string}}
 */
export function plantillaOrdenCreadaAdmin(orden, { urlOrden, urlSitio }) {
  const { cliente } = orden;
  const asunto = `Nueva orden #${orden.id} — ${cliente.nombre} (DNI ${cliente.dni})`;
  const email = cliente.email ?? "—";
  const total = formatearMonto(totalDeItems(orden.items));
  const unidades = unidadesDe(orden.items);

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
    `Total: ${total}`,
    orden.notas ? `\nNotas del cliente: ${orden.notas}` : "",
    "",
    `Ver en el panel: ${urlOrden}`,
  ].join("\n");

  const fila = (etiqueta, valor, relleno) => `
        <tr>
          <td style="padding:${relleno};color:${COLOR_TEXTO_SUAVE};font-size:12px;width:96px;">${etiqueta}</td>
          <td style="padding:${relleno} 0;font-size:15px;color:${COLOR_TEXTO};">${valor}</td>
        </tr>`;

  const enlace = (href, texto) =>
    `<a href="${escaparHtml(href)}" style="color:${COLOR_PRIMARIO};text-decoration:none;">${escaparHtml(texto)}</a>`;

  const fechaHora = formatearFechaHora(orden.createdAt);
  const contexto = [fechaHora, `${unidades} ${unidades === 1 ? "unidad" : "unidades"}`]
    .filter(Boolean)
    .map(escaparHtml)
    .join(" &nbsp;·&nbsp; ");

  const html = envolver({
    urlSitio,
    vistaPrevia: `${total} · ${unidades} ${unidades === 1 ? "unidad" : "unidades"} · ${cliente.nombre}`,
    rotulo: "Orden nueva",
    titulo: `Pedido #${orden.id} · ${total}`,
    contexto,
    cuerpo: `
              ${rotuloSeccion("Cliente")}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background-color:${COLOR_PANEL};border-radius:10px;margin:0 0 26px;">
                ${fila("Nombre", `<strong>${escaparHtml(cliente.nombre)}</strong>`, "16px 20px 6px")}
                ${fila("DNI", escaparHtml(cliente.dni), "0 20px 6px")}
                ${fila("Teléfono", enlace(`tel:${cliente.telefono}`, cliente.telefono), "0 20px 6px")}
                ${fila("Email", cliente.email ? enlace(`mailto:${cliente.email}`, cliente.email) : "—", "0 20px 16px")}
              </table>
              ${rotuloSeccion("Pedido")}
              ${detalleDelPedido(orden.items)}
              ${bloqueNotas("Notas del cliente", orden.notas)}
              <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:28px 0 0;">
                <tr>
                  <td bgcolor="${COLOR_PRIMARIO}" style="background-color:${COLOR_PRIMARIO};border-radius:8px;">
                    <a href="${escaparHtml(urlOrden)}" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:bold;font-family:${FUENTE};">Abrir la orden en el panel</a>
                  </td>
                </tr>
              </table>`,
    pie: `
        <p style="margin:0;color:${COLOR_TEXTO_TENUE};font-size:12px;line-height:1.6;">
          Aviso interno de YIMA · generado automáticamente al entrar la orden
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
 * @param {{id: number, estado: string, updatedAt?: Date, cliente: object, items: Array}} orden
 * @param {{urlSitio?: string}} [opciones]
 * @returns {{asunto: string, texto: string, html: string}}
 */
export function plantillaCambioEstadoCliente(orden, { urlSitio } = {}) {
  const etiqueta = ETIQUETA_ESTADO[orden.estado] ?? orden.estado;
  const asunto = `Tu pedido #${orden.id} está ${etiqueta.toLowerCase()}`;
  const intro = INTRO_POR_ESTADO[orden.estado] ?? `Tu pedido cambió de estado: ${etiqueta}.`;
  const titulo = TITULO_POR_ESTADO[orden.estado] ?? `Tu pedido está ${etiqueta.toLowerCase()}`;
  const total = formatearMonto(totalDeItems(orden.items));

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
    `Total: ${total}`,
    "",
    "Gracias por comprar en YIMA.",
  ].join("\n");

  const fecha = formatearFecha(orden.updatedAt);
  const contexto = fecha
    ? `Pedido <strong style="color:${COLOR_TEXTO};">#${orden.id}</strong> &nbsp;·&nbsp; actualizado el ${escaparHtml(fecha)}`
    : contextoDePedido(orden.id, null);

  const html = envolver({
    urlSitio,
    vistaPrevia: `${intro} Total ${total}.`,
    rotulo: "Actualización de tu pedido",
    titulo,
    contexto,
    cuerpo: `
              ${chipEstado(orden.estado, etiqueta)}
              ${barraProgreso(orden.estado)}
              <p style="margin:0 0 26px;color:${COLOR_TEXTO};font-size:16px;line-height:1.6;">
                Hola ${escaparHtml(orden.cliente.nombre)}, ${escaparHtml(intro)}
              </p>
              ${rotuloSeccion("Detalle del pedido")}
              ${detalleDelPedido(orden.items)}`,
    pie: pieCliente(urlSitio),
  });

  return { asunto, texto, html };
}
