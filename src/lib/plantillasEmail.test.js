import { describe, expect, it } from "vitest";
import {
  escaparHtml,
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
    { nombreProducto: "Lámpara de sal", precioUnitario: "12500.50", cantidad: 2 },
    { nombreProducto: "Difusor", precioUnitario: "8000.00", cantidad: 1 },
  ],
};

describe("formatearMonto", () => {
  it("usa punto para miles y coma para decimales", () => {
    expect(formatearMonto(new Decimal("1234567.5"))).toBe("$1.234.567,50");
  });

  it("siempre muestra dos decimales", () => {
    expect(formatearMonto(new Decimal("100"))).toBe("$100,00");
  });

  it("no agrega separador por debajo de mil", () => {
    expect(formatearMonto(new Decimal("999.99"))).toBe("$999,99");
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
    expect(texto).toContain("$33.001,00");
    expect(html).toContain("$33.001,00");
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
    expect(plantillaOrdenCreadaAdmin(ORDEN, OPCIONES).texto).toContain("$33.001,00");
  });
});

describe("plantillaCambioEstadoCliente", () => {
  it("usa la etiqueta legible del estado en el asunto", () => {
    const enPreparacion = { ...ORDEN, estado: "EN_PREPARACION" };
    expect(plantillaCambioEstadoCliente(enPreparacion).asunto).toBe(
      "Tu pedido #42 está en preparación",
    );
  });

  it("cubre los cinco estados sin devolver undefined en el asunto", () => {
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
    const { texto } = plantillaCambioEstadoCliente({ ...ORDEN, estado: "CONFIRMADA" });
    expect(texto).toContain("Lámpara de sal");
    expect(texto).toContain("$33.001,00");
  });
});
