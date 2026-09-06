import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import { cuerpoProducto } from "./seo.cuerpo.js";

/**
 * Guard de la regla de cloaking sobre el PRECIO.
 *
 * Servirle a un buscador contenido distinto del que ve una persona se penaliza
 * con desindexación. Con una promoción activa, la ficha muestra el precio
 * tachado, el efectivo y el porcentaje: este HTML tiene que mostrar lo mismo.
 *
 * Existe además por un motivo concreto: la primera versión pasó 1503 tests en
 * verde y tiró un 500 en el endpoint real (`decimal.toFixed is not a function`)
 * porque el precio efectivo viajaba como string y `formatearMonto` espera un
 * `Decimal`. Era exactamente la regla 3 del proyecto — la suite verde no
 * alcanza para un cambio de contrato.
 */

function producto(extra = {}) {
  return {
    id: 7,
    nombre: "Termo mate",
    descripcion: "Un termo",
    precio: new Decimal("20000"),
    stock: 4,
    caracteristicas: [],
    listas: [],
    especificaciones: [],
    ...extra,
  };
}

describe("cuerpoProducto — el precio que ve el crawler", () => {
  it("sin promoción muestra un solo precio, formateado", () => {
    expect(cuerpoProducto(producto())).toContain("<p>Precio: $20.000</p>");
  });

  it("con promoción muestra el tachado, el efectivo y el porcentaje", () => {
    // Los tres, como en la ficha. Servirle solo el de lista sería mostrarle a
    // Google un precio que en la página no existe; solo el efectivo, ocultarle
    // que hay oferta.
    const html = cuerpoProducto(producto(), {
      descuento: { porcentaje: 15, precioEfectivo: new Decimal("17000") },
    });

    expect(html).toContain("<s>$20.000</s>");
    expect(html).toContain("$17.000");
    expect(html).toContain("15% OFF");
  });

  it("acepta el precio efectivo como Decimal", () => {
    // El bug real: `formatearMonto` llama a `.toFixed(0)`, que un string no
    // tiene. Pasaba por unit tests que nunca ejercitaban esta rama.
    expect(() =>
      cuerpoProducto(producto(), {
        descuento: { porcentaje: 15, precioEfectivo: new Decimal("17000") },
      }),
    ).not.toThrow();
  });

  it("acepta el precio efectivo como STRING, sin romper", () => {
    // Defensa en profundidad: el llamador no debería tener que saber en qué
    // forma viaja el número para que el HTML del crawler no explote.
    const html = cuerpoProducto(producto(), {
      descuento: { porcentaje: 15, precioEfectivo: "17000" },
    });

    expect(html).toContain("$17.000");
  });

  it("el precio del crawler usa el MISMO formato que la ficha", () => {
    // Miles con punto y sin decimales, como `formatPrecio` del frontend.
    expect(cuerpoProducto(producto({ precio: new Decimal("1250000") }))).toContain("$1.250.000");
  });
});

/**
 * Guard de la regla de cloaking sobre el TEXTO, no solo sobre el precio.
 *
 * La regla es la misma —servirle al buscador contenido distinto del que ve una
 * persona se penaliza con desindexación— pero durante meses solo estuvo
 * cubierto el precio, y el texto divergió en siete puntos (auditado el
 * 06/09/2026). El peor no era un título con otra redacción sino un dato
 * EXCLUSIVO del bot: `Categoría: X`, que la ficha no muestra en ninguna parte.
 *
 * Cada caso de acá nombra su contraparte visible en `FichaProducto.jsx`. Al
 * tocar un título de la ficha, este archivo es el que avisa.
 */
describe("cuerpoProducto — la regla de cloaking sobre el texto", () => {
  it("NO le sirve al bot la categoría, que la ficha no muestra", () => {
    // `FichaProducto.jsx` no renderiza la categoría en ningún lado: no hay
    // migas de pan ni línea de categoría. Emitirla acá es contenido exclusivo
    // para el crawler, que es la definición de cloaking.
    const html = cuerpoProducto(producto({ categoria: { nombre: "Cocina" } }));
    expect(html).not.toContain("Categoría:");
    expect(html).not.toContain("Cocina");
  });

  it("emite la etiqueta pelada, como el Badge de la ficha", () => {
    // La ficha la muestra con `<Badge etiqueta={...} />`, que pinta el texto
    // solo. El prefijo "Etiqueta: " no existe en la página.
    const html = cuerpoProducto(producto({ etiqueta: "Novedad" }));
    expect(html).toContain("<p>Novedad</p>");
    expect(html).not.toContain("Etiqueta:");
  });

  it("dice 'Agotado' sin stock, como la ficha", () => {
    // `FichaProducto.jsx:159`. Decía "Sin stock", que no está en la página.
    const html = cuerpoProducto(producto({ stock: 0 }));
    expect(html).toContain("<p>Agotado</p>");
    expect(html).not.toContain("Sin stock");
  });

  it("dice 'Últimos N' con stock bajo, como la ficha", () => {
    // `FichaProducto.jsx:163`, con el mismo umbral `<= 3` que usa la página.
    expect(cuerpoProducto(producto({ stock: 2 }))).toContain("<p>Últimos 2</p>");
  });

  it("NO dice nada del stock cuando es normal, como la ficha", () => {
    // Con stock holgado la ficha no muestra ninguna línea de stock. Decir
    // "Disponible" era texto que la página no tiene.
    const html = cuerpoProducto(producto({ stock: 20 }));
    expect(html).not.toContain("Disponible");
    expect(html).not.toContain("Últimos");
    expect(html).not.toContain("Agotado");
  });

  it("usa los MISMOS títulos que la ficha, con sus signos", () => {
    const html = cuerpoProducto(
      producto({
        porQueLoVasAQuerer: "Porque sí",
        tePasaEsto: "Se te enfría el mate",
        especificaciones: [{ nombre: "Material", valor: "Acero" }],
        caracteristicas: [{ texto: "Liviano" }],
      }),
    );
    // `FichaProducto.jsx:234` y `:286` — los dos con signos de interrogación,
    // y el segundo NO se llama "¿Te pasa esto?" desde hace meses.
    expect(html).toContain("<h2>¿Por qué lo vas a querer?</h2>");
    expect(html).toContain("<h2>¿Qué problema resuelve?</h2>");
    expect(html).not.toContain("¿Te pasa esto?");
    // `FichaProducto.jsx:381` — Características y Especificaciones son
    // subsecciones de "Ficha técnica", no dos secciones sueltas.
    expect(html).toContain("<h2>Ficha técnica</h2>");
    expect(html).toContain("<h3>Características</h3>");
    expect(html).toContain("<h3>Especificaciones técnicas</h3>");
  });

  it("NO inventa un título para la descripción, que en la ficha va suelta", () => {
    // `FichaProducto.jsx:189-191` la renderiza sin encabezado.
    const html = cuerpoProducto(producto({ descripcion: "Un termo" }));
    expect(html).toContain("Un termo");
    expect(html).not.toContain("<h2>Descripción</h2>");
  });

  it("beneficios y usos van SIN título propio, dentro de su sección", () => {
    // En la ficha no existen los encabezados "Beneficios" ni "Usos": los
    // beneficios viven dentro de "¿Por qué lo vas a querer?" y los usos dentro
    // de "¿Qué problema resuelve?".
    const html = cuerpoProducto(
      producto({
        porQueLoVasAQuerer: "Porque sí",
        tePasaEsto: "Se enfría",
        listas: [
          { tipo: "BENEFICIO", texto: "Dura 12 horas" },
          { tipo: "USO", texto: "Para la playa" },
        ],
      }),
    );
    expect(html).not.toContain("<h2>Beneficios</h2>");
    expect(html).not.toContain("<h2>Usos</h2>");
    expect(html).toContain("Dura 12 horas");
    expect(html).toContain("Para la playa");
  });

  it("emite solo los TRES primeros beneficios, como la ficha", () => {
    // `FichaProducto.jsx:262` hace `.slice(0, 3)`. Emitir los cinco le daría al
    // bot contenido que el visitante no ve.
    const html = cuerpoProducto(
      producto({
        porQueLoVasAQuerer: "Porque sí",
        listas: ["uno", "dos", "tres", "cuatro"].map((texto) => ({ tipo: "BENEFICIO", texto })),
      }),
    );
    expect(html).toContain("uno");
    expect(html).toContain("tres");
    expect(html).not.toContain("cuatro");
  });

  it("incluye los relacionados, que la ficha muestra al pie", () => {
    // `FichaProducto.jsx:436-447`. Son links internos reales: omitirlos le
    // servía al bot una página más pobre que la que ve una persona.
    const html = cuerpoProducto(
      producto({ relacionados: [{ id: 9, nombre: "Bombilla de acero" }] }),
    );
    expect(html).toContain("<h2>También te puede interesar</h2>");
    expect(html).toContain("Bombilla de acero");
  });
});
