import { describe, expect, it } from "vitest";
import { renderHtmlSeo, escapeHtml, serializarJsonLd } from "./htmlSeo.js";

const base = {
  titulo: "Set de cuchillos — YIMA",
  descripcion: "Seis piezas de acero inoxidable.",
  canonical: "https://yima.example.com/producto/12-set-de-cuchillos",
  imagen: "https://res.cloudinary.com/demo/a.jpg",
  bloquesJsonLd: [],
  cuerpo: "<h1>Set de cuchillos</h1>",
};

describe("escapeHtml", () => {
  it("escapa los cinco caracteres peligrosos", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });

  it("devuelve string vacío para nulo o indefinido", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("serializarJsonLd", () => {
  it("escapa el < para que un </script> embebido no cierre el bloque", () => {
    const salida = serializarJsonLd({ name: "Cuchillo </script><script>alert(1)</script>" });

    expect(salida).not.toContain("</script>");
    expect(salida).toContain("\\u003c");
  });

  it("sigue siendo JSON válido que parsea al texto original", () => {
    const original = { name: "Cuchillo </script>" };
    expect(JSON.parse(serializarJsonLd(original))).toEqual(original);
  });
});

describe("renderHtmlSeo", () => {
  it("emite title, description y canonical", () => {
    const html = renderHtmlSeo(base);

    expect(html).toContain("<title>Set de cuchillos — YIMA</title>");
    expect(html).toContain('<meta name="description" content="Seis piezas de acero inoxidable." />');
    expect(html).toContain('<link rel="canonical" href="https://yima.example.com/producto/12-set-de-cuchillos" />');
  });

  it("emite los tags Open Graph y Twitter con la misma imagen", () => {
    const html = renderHtmlSeo(base);

    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:url"');
    expect(html).toContain('content="https://res.cloudinary.com/demo/a.jpg"');
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  it("usa og:type website por defecto y respeta el que se le pase", () => {
    expect(renderHtmlSeo(base)).toContain('property="og:type" content="website"');
    expect(renderHtmlSeo({ ...base, tipoOg: "product" })).toContain('property="og:type" content="product"');
  });

  it("NO emite robots noindex por defecto", () => {
    expect(renderHtmlSeo(base)).not.toContain("noindex");
  });

  it("emite robots noindex cuando se lo pide", () => {
    expect(renderHtmlSeo({ ...base, noindex: true })).toContain('<meta name="robots" content="noindex, follow" />');
  });

  it("inserta el cuerpo dentro del body", () => {
    expect(renderHtmlSeo(base)).toContain("<body>\n<h1>Set de cuchillos</h1>\n</body>");
  });

  it("emite un bloque script por cada JSON-LD", () => {
    const html = renderHtmlSeo({
      ...base,
      bloquesJsonLd: [{ "@type": "Product" }, { "@type": "BreadcrumbList" }],
    });

    const bloques = html.match(/<script type="application\/ld\+json">/g);
    expect(bloques).toHaveLength(2);
  });

  it("escapa el título y la descripción en los atributos", () => {
    const html = renderHtmlSeo({ ...base, titulo: 'Cuchillo "premium" & co' });

    expect(html).toContain("&quot;premium&quot;");
    expect(html).not.toContain('content="Cuchillo "premium"');
  });

  it("declara lang es y el charset", () => {
    const html = renderHtmlSeo(base);
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('<meta charset="UTF-8" />');
  });

  // Sin este tag, un buscador no tiene de dónde sacar el favicon del resultado
  // —`/favicon.ico` acá devuelve el index.html de la SPA, no una imagen— y el
  // resultado sale con el globo gris genérico.
  it("emite el link del favicon en el origen del canonical", () => {
    const html = renderHtmlSeo(base);
    expect(html).toContain(
      '<link rel="icon" type="image/png" sizes="144x144" href="https://yima.example.com/favicon.png" />',
    );
  });

  it("apunta el favicon a la raíz del sitio, no a la ruta de la página", () => {
    const html = renderHtmlSeo({
      ...base,
      canonical: "https://yima.example.com/coleccion/categoria/cocina",
    });
    expect(html).toContain('href="https://yima.example.com/favicon.png"');
  });

  it("también lo emite en el documento noindex", () => {
    const html = renderHtmlSeo({ ...base, noindex: true });
    expect(html).toContain('rel="icon"');
    expect(html).toContain('<meta name="robots" content="noindex, follow" />');
  });

  it("omite el tag sin romper el documento si el canonical es inservible", () => {
    const html = renderHtmlSeo({ ...base, canonical: "no-es-una-url" });
    expect(html).not.toContain('rel="icon"');
    expect(html).toContain("<title>Set de cuchillos — YIMA</title>");
  });
});
