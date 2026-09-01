import { describe, expect, it } from "vitest";
import {
  escaparHtml,
  formatearFecha,
  formatearFechaHora,
  formatearMonto,
  plantillaCambioEstadoCliente,
  plantillaOrdenCreadaAdmin,
  plantillaOrdenCreadaCliente,
} from "./plantillasEmail.js";
import { Decimal } from "@prisma/client/runtime/client.js";
import { ESTADOS_ORDEN } from "./estadosOrden.js";

const ORDEN = {
  id: 42,
  estado: "PENDIENTE",
  notas: "Tocar timbre 3B",
  cliente: {
    dni: "12345678",
    nombre: "Juan Pérez",
    telefono: "1122334455",
    email: "juan@gmail.com",
  },
  items: [
    // Enteros: `ItemOrden.precioUnitario` es `Decimal(10, 0)`, un snapshot con
    // centavos ya no es un caso alcanzable.
    { nombreProducto: "Lámpara de sal", precioUnitario: "12500", cantidad: 2 },
    { nombreProducto: "Difusor", precioUnitario: "8000", cantidad: 1 },
  ],
};

describe("formatearMonto", () => {
  it("usa punto para miles y no emite decimales", () => {
    expect(formatearMonto(new Decimal("1234567"))).toBe("$1.234.567");
  });

  it("no agrega separador por debajo de mil", () => {
    expect(formatearMonto(new Decimal("999"))).toBe("$999");
  });

  // Los montos del sistema son enteros, así que esto no debería pasar nunca.
  // Se fija igual porque la alternativa — emitir la cola de decimales tal
  // cual — sacaría un `$999,99` en un mail donde todo el resto de los montos
  // va sin centavos, y ese es justo el tipo de detalle que hace dudar de un
  // total. Un valor así solo puede llegar por una vía que no pasa por la
  // validación (un UPDATE a mano en la base).
  it("redondea un valor con centavos en vez de arrastrarlos", () => {
    expect(formatearMonto(new Decimal("999.99"))).toBe("$1.000");
    expect(formatearMonto(new Decimal("1234.4"))).toBe("$1.234");
  });
});

describe("escaparHtml", () => {
  it("escapa los caracteres que romperían el markup", () => {
    expect(escaparHtml('<b>"Juan" & Cía</b>')).toBe(
      "&lt;b&gt;&quot;Juan&quot; &amp; Cía&lt;/b&gt;",
    );
  });

  it("devuelve string vacío ante null o undefined", () => {
    expect(escaparHtml(null)).toBe("");
    expect(escaparHtml(undefined)).toBe("");
  });
});

describe("plantillaOrdenCreadaCliente", () => {
  it("nombra el número de orden en el asunto", () => {
    expect(plantillaOrdenCreadaCliente(ORDEN).asunto).toBe("Recibimos tu pedido #42");
  });

  it("lista todos los items en el texto plano", () => {
    const { texto } = plantillaOrdenCreadaCliente(ORDEN);
    expect(texto).toContain("Lámpara de sal");
    expect(texto).toContain("Difusor");
  });

  it("calcula el total con Decimal, no con float", () => {
    // 12500.50 * 2 + 8000 = 33001.00 exacto. Con float el .50 * 2 arrastra.
    const { texto, html } = plantillaOrdenCreadaCliente(ORDEN);
    expect(texto).toContain("$33.000");
    expect(html).toContain("$33.000");
  });

  it("incluye las notas cuando la orden las tiene", () => {
    expect(plantillaOrdenCreadaCliente(ORDEN).texto).toContain("Tocar timbre 3B");
  });

  it("omite la sección de notas cuando no las hay", () => {
    const sinNotas = { ...ORDEN, notas: null };
    expect(plantillaOrdenCreadaCliente(sinNotas).texto).not.toContain("Notas");
  });

  it("emite una versión de texto plano no vacía", () => {
    expect(plantillaOrdenCreadaCliente(ORDEN).texto.trim().length).toBeGreaterThan(0);
  });

  it("escapa el nombre del producto en el HTML", () => {
    const conMarkup = {
      ...ORDEN,
      items: [{ nombreProducto: "Vela <script>", precioUnitario: "100.00", cantidad: 1 }],
    };
    const { html } = plantillaOrdenCreadaCliente(conMarkup);
    expect(html).toContain("Vela &lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("no usa CSS moderno en el HTML", () => {
    const { html } = plantillaOrdenCreadaCliente(ORDEN);
    expect(html).not.toContain("display:flex");
    expect(html).not.toContain("display: flex");
    expect(html).not.toContain("display:grid");
    expect(html).not.toContain("<link");
  });
});

describe("plantillaOrdenCreadaAdmin", () => {
  const OPCIONES = { urlOrden: "https://yima.test/catalogo/admin/ordenes/42" };

  it("pone nombre y DNI del cliente en el asunto, para escanear la bandeja", () => {
    expect(plantillaOrdenCreadaAdmin(ORDEN, OPCIONES).asunto).toBe(
      "Nueva orden #42 — Juan Pérez (DNI 12345678)",
    );
  });

  it("incluye el link directo al detalle en el panel", () => {
    const { texto, html } = plantillaOrdenCreadaAdmin(ORDEN, OPCIONES);
    expect(texto).toContain(OPCIONES.urlOrden);
    expect(html).toContain(`href="${OPCIONES.urlOrden}"`);
  });

  it("incluye los datos de contacto que el mail al cliente no necesita", () => {
    const { texto } = plantillaOrdenCreadaAdmin(ORDEN, OPCIONES);
    expect(texto).toContain("1122334455");
    expect(texto).toContain("juan@gmail.com");
  });

  it("muestra un guion cuando el cliente no dejó email", () => {
    const sinEmail = { ...ORDEN, cliente: { ...ORDEN.cliente, email: null } };
    expect(plantillaOrdenCreadaAdmin(sinEmail, OPCIONES).texto).toContain("Email: —");
  });

  it("calcula el total con Decimal", () => {
    expect(plantillaOrdenCreadaAdmin(ORDEN, OPCIONES).texto).toContain("$33.000");
  });
});

describe("plantillaCambioEstadoCliente", () => {
  it("usa la etiqueta legible del estado en el asunto", () => {
    const enPreparacion = { ...ORDEN, estado: "EN_PREPARACION" };
    expect(plantillaCambioEstadoCliente(enPreparacion).asunto).toBe(
      "Tu pedido #42 está en preparación",
    );
  });

  it("cubre los cuatro estados sin devolver undefined en el asunto", () => {
    for (const estado of ESTADOS_ORDEN) {
      const { asunto } = plantillaCambioEstadoCliente({ ...ORDEN, estado });
      expect(asunto).not.toContain("undefined");
      expect(asunto.startsWith("Tu pedido #42 está ")).toBe(true);
    }
  });

  it("le da a CANCELADA un texto distinto del de ENTREGADA", () => {
    const cancelada = plantillaCambioEstadoCliente({ ...ORDEN, estado: "CANCELADA" });
    const entregada = plantillaCambioEstadoCliente({ ...ORDEN, estado: "ENTREGADA" });
    expect(cancelada.texto).not.toBe(entregada.texto);
  });

  it("repite el detalle de la orden para que el mail se entienda solo", () => {
    const { texto } = plantillaCambioEstadoCliente({ ...ORDEN, estado: "EN_PREPARACION" });
    expect(texto).toContain("Lámpara de sal");
    expect(texto).toContain("$33.000");
  });
});

describe("copy por estado sin CONFIRMADA", () => {
  const OPCIONES = { urlSitio: "https://yima-productos.com" };

  it("el mail de EN_PREPARACION comunica que el pedido fue aceptado", () => {
    const mail = plantillaCambioEstadoCliente({ ...ORDEN, estado: "EN_PREPARACION" }, OPCIONES);

    // El asunto sigue lowercaseando la etiqueta ("está en preparación"), como
    // ya hacía antes de este cambio — lo nuevo es que el CUERPO pasa a decir
    // que el pedido fue aceptado, no solo que "se está preparando".
    expect(mail.asunto).toContain("en preparación");
    expect(mail.texto).toContain("Confirmamos tu pedido");
  });

  it("la barra de avance tiene tres pasos", () => {
    const mail = plantillaCambioEstadoCliente({ ...ORDEN, estado: "ENTREGADA" }, OPCIONES);

    // Tres celdas de la barra, cada una al 33% del ancho.
    expect(mail.html.match(/width="33%"/g)).toHaveLength(3);
    expect(mail.html).not.toContain('width="25%"');
  });

  it("una orden CANCELADA no dibuja barra de avance", () => {
    const mail = plantillaCambioEstadoCliente({ ...ORDEN, estado: "CANCELADA" }, OPCIONES);

    expect(mail.html).not.toContain('width="33%"');
  });
});

describe("formatearFecha", () => {
  it("escribe el mes en palabras, en castellano", () => {
    expect(formatearFecha(new Date("2026-08-26T15:00:00Z"))).toBe("26 de agosto de 2026");
  });

  // El contenedor corre en UTC y el negocio vive en Argentina (UTC-3, sin
  // horario de verano desde 2009). Un pedido de las 21:30 de Buenos Aires es
  // 00:30 UTC del día siguiente: leer la fecha en UTC le pondría al cliente el
  // día equivocado en su propio comprobante.
  it("usa la hora de Argentina, no la del servidor", () => {
    expect(formatearFecha(new Date("2026-08-27T00:30:00Z"))).toBe("26 de agosto de 2026");
  });

  it("devuelve null ante una fecha ausente o ilegible", () => {
    expect(formatearFecha(null)).toBeNull();
    expect(formatearFecha(undefined)).toBeNull();
    expect(formatearFecha(new Date("no es una fecha"))).toBeNull();
  });

  it("acepta el string ISO que devuelve una API además del Date de Prisma", () => {
    expect(formatearFecha("2026-01-05T12:00:00Z")).toBe("5 de enero de 2026");
  });
});

describe("formatearFechaHora", () => {
  it("agrega la hora de Argentina con dos dígitos", () => {
    expect(formatearFechaHora(new Date("2026-08-26T22:42:00Z"))).toBe(
      "26 de agosto de 2026, 19:42",
    );
  });

  it("devuelve null ante una fecha ilegible", () => {
    expect(formatearFechaHora(null)).toBeNull();
  });
});

describe("documento HTML de los mails", () => {
  const OPCIONES = { urlSitio: "https://yima.test" };

  it("emite un documento completo, no un fragmento suelto", () => {
    const { html } = plantillaOrdenCreadaCliente(ORDEN, OPCIONES);
    expect(html.trimStart().startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="es"');
    expect(html).toContain("</html>");
  });

  // Sin esto, Gmail y Apple Mail invierten los colores por su cuenta y la
  // paleta de la marca sale embarrada — el fondo crema se vuelve gris sucio y
  // el terracota pierde contraste contra él.
  it("declara el esquema de color claro para frenar la inversión automática", () => {
    const { html } = plantillaOrdenCreadaCliente(ORDEN, OPCIONES);
    expect(html).toContain('name="color-scheme"');
    expect(html).toContain('name="supported-color-schemes"');
  });

  it("sirve el logo desde el sitio público", () => {
    const { html } = plantillaOrdenCreadaCliente(ORDEN, OPCIONES);
    expect(html).toContain('src="https://yima.test/logo-yima-160.png"');
    expect(html).toContain('alt="YIMA"');
  });

  // Las imágenes bloqueadas son el estado por defecto de Outlook. El `alt` es
  // lo único que queda en pantalla, así que va estilado como wordmark en vez
  // de quedar como texto suelto del navegador.
  it("estila el texto alternativo del logo para el cliente que bloquea imágenes", () => {
    const { html } = plantillaOrdenCreadaCliente(ORDEN, OPCIONES);
    const tagLogo = html.match(/<img[^>]*alt="YIMA"[^>]*>/)?.[0] ?? "";
    expect(tagLogo).toContain("letter-spacing");
    expect(tagLogo).toContain("font-weight:bold");
  });

  it("cae al wordmark de texto cuando no hay sitio público configurado", () => {
    const { html } = plantillaOrdenCreadaCliente(ORDEN);
    expect(html).not.toContain("<img");
    expect(html).toContain("YIMA");
  });

  it("abre con un texto de vista previa oculto", () => {
    const { html } = plantillaOrdenCreadaCliente(ORDEN, OPCIONES);
    const preheader = html.match(/<div[^>]*max-height:0[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
    expect(preheader).toContain("$33.000");
  });

  it("no usa CSS moderno ni hojas externas en ninguna de las tres plantillas", () => {
    const htmls = [
      plantillaOrdenCreadaCliente(ORDEN, OPCIONES).html,
      plantillaOrdenCreadaAdmin(ORDEN, { ...OPCIONES, urlOrden: "https://yima.test/x" }).html,
      plantillaCambioEstadoCliente({ ...ORDEN, estado: "EN_PREPARACION" }, OPCIONES).html,
    ];
    for (const html of htmls) {
      expect(html).not.toContain("display:flex");
      expect(html).not.toContain("display:grid");
      expect(html).not.toContain("<link");
    }
  });
});

describe("detalle de items", () => {
  it("muestra el precio unitario debajo del nombre, además del subtotal", () => {
    const { html } = plantillaOrdenCreadaCliente(ORDEN, { urlSitio: "https://yima.test" });
    expect(html).toContain("$12.500 c/u");
    expect(html).toContain("$25.000");
  });
});

describe("estado en el mail de cambio de estado", () => {
  const OPCIONES = { urlSitio: "https://yima.test" };

  it("le da a cada estado su propio color de chip", () => {
    const colores = ESTADOS_ORDEN.map((estado) => {
      const { html } = plantillaCambioEstadoCliente({ ...ORDEN, estado }, OPCIONES);
      return html.match(/border-radius:999px;padding:9px 20px;background-color:(#[0-9a-f]{6})/)?.[1];
    });
    expect(colores.every(Boolean)).toBe(true);
    // CANCELADA no puede leerse con el mismo color que ENTREGADA.
    expect(new Set(colores).size).toBeGreaterThan(1);
    const cancelada = colores[ESTADOS_ORDEN.indexOf("CANCELADA")];
    const entregada = colores[ESTADOS_ORDEN.indexOf("ENTREGADA")];
    expect(cancelada).not.toBe(entregada);
  });

  it("avanza la barra de progreso un paso por estado", () => {
    const pasosCompletos = (estado) => {
      const { html } = plantillaCambioEstadoCliente({ ...ORDEN, estado }, OPCIONES);
      return (html.match(/background-color:#9d3e1d;border-radius:2px/g) ?? []).length;
    };
    expect(pasosCompletos("PENDIENTE")).toBe(1);
    expect(pasosCompletos("EN_PREPARACION")).toBe(2);
    expect(pasosCompletos("ENTREGADA")).toBe(3);
  });

  // Una orden cancelada no está "a un paso de entregarse": mostrar la barra
  // sugeriría que el pedido sigue en curso.
  it("no muestra la barra de progreso en una orden cancelada", () => {
    const { html } = plantillaCambioEstadoCliente({ ...ORDEN, estado: "CANCELADA" }, OPCIONES);
    expect(html).not.toContain("border-radius:2px");
  });
});
