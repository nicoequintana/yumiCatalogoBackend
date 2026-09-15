import { describe, expect, it } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import { cuerpoCombo, cuerpoProducto, listaTarjetasCombo } from "./seo.cuerpo.js";

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

  it("emite el NOMBRE de la etiqueta, pelado y sin prefijo", () => {
    // La ficha la muestra con `<Badge etiqueta={...} />`, que pinta el texto
    // solo. El prefijo "Etiqueta: " no existe en la página.
    //
    // `cuerpoProducto` recibe acá la fila CRUDA de Prisma: `seo.controller.js`
    // arma el cuerpo con `{ ...producto, relacionados }` sobre el resultado de
    // `prisma.product.findUnique({ include: PRODUCT_INCLUDE })`, sin pasar por
    // `mapProducto`. `PRODUCT_INCLUDE.etiqueta` es `true` (`products.mapper.js:22`,
    // afirmado en `products.mapper.test.js:370`): trae la fila COMPLETA de
    // `Etiqueta` tal cual la guarda la base, así que `color` es el id de la
    // paleta (`"TERRACOTA"`), nunca los canales — la fixture usa esa forma,
    // NO la `{ colorFondo, colorTexto }` que arma `mapEtiqueta` para el JSON
    // de la API, que acá nunca llega.
    const html = cuerpoProducto(
      producto({ etiqueta: { id: 1, nombre: "Nuevo", color: "TERRACOTA" } }),
    );
    expect(html).toContain("<p>Nuevo</p>");
    expect(html).not.toContain("Etiqueta:");
    expect(html).not.toContain("[object Object]");
  });

  it("sin etiqueta no emite el párrafo", () => {
    const html = cuerpoProducto(producto({ etiqueta: null }));
    expect(html).not.toContain("<p></p>");
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

/**
 * Combo en la forma PÚBLICA (`mapComboPublico`): la misma que pintan
 * `PaginaCombo.jsx` y `TarjetaCombo.jsx`, y la que recibe el cuerpo del bot.
 */
function comboPublico(extra = {}) {
  return {
    id: 3,
    ruta: "/combos/3-kit-living-calido",
    nombre: "Kit Living Cálido",
    frase: "Luz suave y una mesa de roble.",
    porcentaje: 15,
    unidades: 3,
    precioSeparado: "45000",
    precioCombo: "38250",
    ahorro: "6750",
    alcanza: 4,
    disponible: true,
    quedanPocos: false,
    heroUrl: null,
    items: [
      { productId: 1, nombre: "Lámpara", cantidad: 2, precioLista: "10000", categoria: "Iluminación" },
      { productId: 2, nombre: "Mesa", cantidad: 1, precioLista: "25000", categoria: null },
    ],
    ...extra,
  };
}

/**
 * Guard de la regla de cloaking de la página del combo: cada texto afirmado
 * es un texto VISIBLE de `PaginaCombo.jsx`, con su misma jerarquía (los
 * rótulos "Qué incluye" y "La cuenta" son eyebrows sobre el `<h2>`, no el
 * `<h2>`). Los controles (cantidad, "Agregar combo", WhatsApp) no son
 * contenido, igual que en `cuerpoProducto`.
 */
describe("cuerpoCombo — el mismo texto que PaginaCombo.jsx", () => {
  it("ticket: título, frase y el talón con Por separado, Precio combo y Ahorrás", () => {
    const html = cuerpoCombo(comboPublico());

    expect(html).toContain("<h1>Kit Living Cálido</h1>");
    expect(html).toContain("<p>Luz suave y una mesa de roble.</p>");
    expect(html).toContain("<p>3 productos</p>");
    expect(html).toContain("<p>-15% Combo</p>");
    expect(html).toContain("<p>Por separado <s>$45.000</s></p>");
    expect(html).toContain("<p>Precio combo $38.250</p>");
    expect(html).toContain("<p>Ahorrás $6.750</p>");
  });

  it("Qué incluye: rótulo, título y cada producto con categoría, cantidad y precio de lista", () => {
    const html = cuerpoCombo(comboPublico());

    expect(html).toContain(
      "<section><p>Qué incluye</p><h2>3 productos, un solo precio</h2><ul>" +
        "<li><p>Iluminación</p><p>2 × Lámpara</p><p>Precio de lista $10.000 c/u</p></li>" +
        "<li><p>Mesa</p><p>Precio de lista $25.000</p></li>" +
        "</ul></section>",
    );
  });

  it("La cuenta: rótulo, título, bajada y el recibo", () => {
    const html = cuerpoCombo(comboPublico());

    expect(html).toContain(
      "<section><p>La cuenta</p><h2>Juntos te salen $6.750 menos</h2>" +
        "<p>Llevándolos en combo pagás menos que comprando cada producto a su precio de lista.</p>" +
        "<dl><dt>Por separado (3 productos)</dt><dd>$45.000</dd>" +
        "<dt>Descuento combo 15%</dt><dd>− $6.750</dd>" +
        "<dt>Precio combo</dt><dd>$38.250</dd></dl></section>",
    );
  });

  it("agotado dice 'Agotado' y con pocos 'Quedan N', como el chip de la página", () => {
    expect(cuerpoCombo(comboPublico({ disponible: false, alcanza: 0 }))).toContain("<p>Agotado</p>");
    expect(cuerpoCombo(comboPublico({ quedanPocos: true, alcanza: 2 }))).toContain("<p>Quedan 2</p>");
    const normal = cuerpoCombo(comboPublico());
    expect(normal).not.toContain("Agotado");
    expect(normal).not.toContain("Quedan");
  });

  it("no inventa textos que la página no tiene", () => {
    const html = cuerpoCombo(comboPublico());
    expect(html).not.toContain("Agregar combo");
    expect(html).not.toContain(":");
  });

  it("escapa el nombre, la frase y los productos", () => {
    const html = cuerpoCombo(
      comboPublico({
        nombre: "<b>Kit</b>",
        frase: "<i>x</i>",
        items: [{ productId: 1, nombre: "<script>", cantidad: 2, precioLista: "1", categoria: null }],
      }),
    );
    expect(html).toContain("<h1>&lt;b&gt;Kit&lt;/b&gt;</h1>");
    expect(html).toContain("&lt;i&gt;x&lt;/i&gt;");
    expect(html).not.toContain("<script>");
  });
});

/**
 * La card (`TarjetaCombo.jsx`) repetida en texto: la usan la sección de la
 * ficha y `/og/combos`.
 */
describe("listaTarjetasCombo — el mismo texto que TarjetaCombo.jsx", () => {
  it("cada card con nombre, frase, productos y el talón", () => {
    const html = listaTarjetasCombo([comboPublico()]);

    expect(html).toBe(
      "<ul><li>" +
        "<p>3 productos</p><h3>Kit Living Cálido</h3><p>Luz suave y una mesa de roble.</p>" +
        "<p>2× Lámpara · Mesa</p>" +
        "<p>-15% Combo</p><p>Por separado <s>$45.000</s></p><p>Precio combo $38.250</p><p>Ahorrás $6.750</p>" +
        "</li></ul>",
    );
  });

  it("con href enlaza el nombre a la página del combo", () => {
    const html = listaTarjetasCombo([comboPublico()], { frontendUrl: "https://yima.example.com" });
    expect(html).toContain('<h3><a href="https://yima.example.com/combos/3-kit-living-calido">Kit Living Cálido</a></h3>');
  });

  it("sin combos no emite nada", () => {
    expect(listaTarjetasCombo([])).toBe("");
  });
});

describe("cuerpoProducto — Llevalo en combo y ahorrá", () => {
  it("con combos suma la sección al pie, con el eyebrow y las cards", () => {
    const html = cuerpoProducto(producto({ relacionados: [{ nombre: "Bombilla" }], combos: [comboPublico()] }));

    expect(html).toContain("<section><p>Combos</p><h2>Llevalo en combo y ahorrá</h2><ul><li>");
    expect(html).toContain("<h3>Kit Living Cálido</h3>");
    expect(html).toContain("<p>Precio combo $38.250</p>");
    // Debajo de los relacionados, como en `FichaProducto.jsx`.
    expect(html.indexOf("Llevalo en combo")).toBeGreaterThan(html.indexOf("También te puede interesar"));
  });

  it("sin combos no aparece la sección", () => {
    expect(cuerpoProducto(producto({ combos: [] }))).not.toContain("Llevalo en combo y ahorrá");
    expect(cuerpoProducto(producto())).not.toContain("Llevalo en combo y ahorrá");
  });
});
