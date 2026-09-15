import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const findUniqueMock = vi.fn();
const findManyMock = vi.fn(async () => []);
const comboItemFindManyMock = vi.fn(async () => []);
const comboFindManyMock = vi.fn(async () => []);
const comboFindUniqueMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {     // Sin promociones vigentes, que es el caso normal y el que deja el precio
    // igual al de lista. Ver `lib/precioEfectivo.js`.
    promocionItem: { findMany: async () => [] },
    product: {
      findUnique: (...args) => findUniqueMock(...args),
      // `obtenerRelacionados`, que el cuerpo del crawler usa desde el
      // 06/09/2026 para servir el mismo "También te puede interesar" que la
      // ficha. Sin esta línea el endpoint tira 500 — lo atraparon estos tests,
      // no los unitarios de `seo.cuerpo.js`.
      findMany: (...args) => findManyMock(...args),
    },
    // `servirSeoProducto` lista los combos del producto
    // (`obtenerCombosDelProducto`) y las rutas de combos leen `combo`. Sin
    // combos por defecto.
    comboItem: { findMany: (...args) => comboItemFindManyMock(...args) },
    combo: {
      findMany: (...args) => comboFindManyMock(...args),
      findUnique: (...args) => comboFindUniqueMock(...args),
    },
  },
}));

const { default: ogRouter } = await import("./og.routes.js");

function buildApp() {
  const app = express();
  app.use("/og", ogRouter);
  return app;
}

function productoCompleto(extra = {}) {
  return {
    id: 5,
    nombre: "Set de cuchillos",
    descripcion: "Seis piezas de acero inoxidable con mango ergonómico.",
    sku: "YIMA-0005",
    // `PRODUCT_INCLUDE.etiqueta` es `true` (`products.mapper.js:22`, afirmado
    // en `products.mapper.test.js:370`): trae la fila COMPLETA de `Etiqueta`
    // tal cual la guarda la base, así que `color` es el id de la paleta
    // (`"TERRACOTA"`), nunca los canales — no el `{ colorFondo, colorTexto }`
    // que arma `mapEtiqueta` para la API, este mock nunca pasa por el mapper.
    etiqueta: { id: 1, nombre: "Nuevo", color: "TERRACOTA" },
    // Espeja un Decimal de Prisma de verdad: `toString()` para el JSON-LD,
    // `toFixed()` para `formatearMonto` (`lib/plantillasEmail.js`), que arma
    // el precio formateado del cuerpo del crawler.
    precio: { toString: () => "45000.00", toFixed: (n) => Number(45000).toFixed(n) },
    stock: 4,
    visibleEnCatalogo: true,
    fraseComercial: "La cocina que siempre quisiste.",
    porQueLoVasAQuerer: "Cortan parejo y no se oxidan.",
    tePasaEsto: "Se te resbala el cuchillo al cortar.",
    categoria: { id: 3, nombre: "Cocina" },
    caracteristicas: [{ id: 1, texto: "Acero inoxidable" }],
    listas: [
      { id: 1, tipo: "BENEFICIO", texto: "Filo duradero", orden: 0 },
      { id: 2, tipo: "USO", texto: "Cortar verduras", orden: 0 },
      { id: 3, tipo: "IDEAL_PARA", texto: "Cocinar en casa", orden: 0 },
      { id: 4, tipo: "INCLUYE", texto: "Taco de madera", orden: 0 },
    ],
    especificaciones: [{ id: 1, nombre: "Material", valor: "Acero", orden: 0 }],
    fotos: [{ id: 1, orden: 0, url: "https://res.cloudinary.com/demo/a.jpg", cloudinaryPublicId: "a", driveFileId: null }],
    video: null,
    ...extra,
  };
}

const UA_BOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const UA_NAVEGADOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0";

beforeEach(() => {
  findUniqueMock.mockReset();
  comboFindUniqueMock.mockReset();
  comboFindManyMock.mockReset();
  comboFindManyMock.mockResolvedValue([]);
  comboItemFindManyMock.mockReset();
  comboItemFindManyMock.mockResolvedValue([]);
  process.env.FRONTEND_URL = "https://yima.example.com";
  process.env.BACKEND_PUBLIC_URL = "https://api.yima.example.com";
});

describe("GET /og/producto/:idSlug — producto visible", () => {
  it("responde 200 con el título del producto y el canonical con slug", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5-set-de-cuchillos").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain("<title>Set de cuchillos — YIMA</title>");
    expect(res.text).toContain('<link rel="canonical" href="https://yima.example.com/producto/5-set-de-cuchillos" />');
    expect(res.text).not.toContain("noindex");
  });

  it("acepta el id pelado, sin slug, y canoniza igual a la URL con slug", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.text).toContain('href="https://yima.example.com/producto/5-set-de-cuchillos"');
  });

  it("usa la frase comercial como description, no la descripción larga", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.text).toContain('name="description" content="La cocina que siempre quisiste."');
  });

  it("cae a la descripción truncada cuando no hay frase comercial", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto({ fraseComercial: null }));

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.text).toContain("Seis piezas de acero inoxidable");
  });

  it("emite el cuerpo con TODO el contenido de la ficha (regla de cloaking)", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.text).toContain("<h1>Set de cuchillos</h1>");
    expect(res.text).toContain("Seis piezas de acero inoxidable");
    expect(res.text).toContain("Cortan parejo y no se oxidan");
    expect(res.text).toContain("Se te resbala el cuchillo al cortar");
    expect(res.text).toContain("Filo duradero");
    expect(res.text).toContain("Cortar verduras");
    expect(res.text).toContain("Cocinar en casa");
    expect(res.text).toContain("Taco de madera");
    expect(res.text).toContain("Acero inoxidable");
    expect(res.text).toContain("Material");
    // La etiqueta PELADA. Este test afirmaba "Etiqueta: Nuevo" hasta el
    // 06/09/2026: ese prefijo no existe en la ficha, que la muestra con
    // `<Badge>`. Era la propia regla de cloaking incumplida por el test que la
    // custodia.
    expect(res.text).toContain(">Nuevo<");
    expect(res.text).not.toContain("Etiqueta:");
    // Y la categoría NO viaja: la ficha no la muestra en ningún lado.
    expect(res.text).not.toContain("Categoría:");
  });

  it("emite los bloques JSON-LD de Product y BreadcrumbList", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    const bloques = [...res.text.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)]
      .map((m) => JSON.parse(m[1]));

    expect(bloques).toHaveLength(2);
    expect(bloques[0]["@type"]).toBe("Product");
    expect(bloques[0].offers.price).toBe("45000.00");
    expect(bloques[0].offers.availability).toBe("https://schema.org/InStock");
    expect(bloques[1]["@type"]).toBe("BreadcrumbList");
  });

  it("consulta la base con PRODUCT_INCLUDE, no solo con las fotos", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    const [args] = findUniqueMock.mock.calls[0];
    expect(args.where).toEqual({ id: 5 });
    expect(args.include).toHaveProperty("especificaciones");
    expect(args.include).toHaveProperty("listas");
    expect(args.include).toHaveProperty("caracteristicas");
  });
});

describe("GET /og/producto/:idSlug — producto agotado", () => {
  it("responde 200 e indexa, con availability OutOfStock", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto({ stock: 0 }));

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    // Agotado es un estado comercial: el detalle público devuelve 200 a
    // propósito para que un link compartido no se rompa.
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("noindex");
    expect(res.text).toContain("https://schema.org/OutOfStock");
  });
});

describe("GET /og/producto/:idSlug — 404 reales", () => {
  it("responde 404 + noindex cuando el producto está oculto", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto({ visibleEnCatalogo: false }));

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(res.text).toContain('content="noindex, follow"');
    expect(res.text).not.toContain("Set de cuchillos");
  });

  it("responde 404 + noindex cuando el producto no existe", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/og/producto/999").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(res.text).toContain('content="noindex, follow"');
  });

  it("responde 404 sin tocar la base cuando el id no es numérico", async () => {
    const res = await request(buildApp()).get("/og/producto/set-de-cuchillos").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });

  it("responde 404 sin tocar la base cuando el id es un decimal", async () => {
    const res = await request(buildApp()).get("/og/producto/12.5").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});

describe("GET /og/producto/:idSlug — navegador", () => {
  it("redirige 302 a la SPA con la URL canónica cuando el UA no es bot", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_NAVEGADOR);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://yima.example.com/producto/5-set-de-cuchillos");
  });

  it("redirige a la home cuando el id no resuelve un producto", async () => {
    findUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/og/producto/999").set("User-Agent", UA_NAVEGADOR);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://yima.example.com/");
  });
});

describe("GET /og/producto/:idSlug — escape", () => {
  it("no deja que un nombre con </script> cierre el bloque JSON-LD", async () => {
    findUniqueMock.mockResolvedValue(
      productoCompleto({ nombre: "Cuchillo </script><script>alert(1)</script>" }),
    );

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    // Solo pueden existir los dos cierres de los dos bloques JSON-LD.
    expect(res.text.match(/<\/script>/g)).toHaveLength(2);
    expect(res.text).not.toContain("<script>alert(1)</script>");
  });
});

/** Una fila de `combo` como la trae Prisma con `PUBLIC_INCLUDE`. */
function comboCompleto(extra = {}) {
  const precio = (valor) => ({ toString: () => valor });
  return {
    id: 3,
    nombre: "Kit Living Cálido",
    frase: "Luz suave y una mesa de roble.",
    porcentaje: 15,
    activo: true,
    vigencia: "SIEMPRE",
    heroUrl: "https://res.cloudinary.com/demo/hero-kit.jpg",
    campanias: [],
    items: [
      {
        productId: 1,
        cantidad: 2,
        product: { id: 1, nombre: "Lámpara", precio: precio("10000"), stock: 9, visibleEnCatalogo: true, categoria: null, fotos: [] },
      },
      {
        productId: 2,
        cantidad: 1,
        product: { id: 2, nombre: "Mesa", precio: precio("25000"), stock: 4, visibleEnCatalogo: true, categoria: null, fotos: [] },
      },
    ],
    ...extra,
  };
}

function conStock(combo, stock) {
  return { ...combo, items: combo.items.map((i) => ({ ...i, product: { ...i.product, stock } })) };
}

describe("GET /og/producto/:idSlug — combos del producto en el cuerpo", () => {
  it("lista los combos vigentes del producto, como la ficha", async () => {
    findUniqueMock.mockResolvedValue(productoCompleto());
    comboItemFindManyMock.mockResolvedValueOnce([{ combo: comboCompleto() }]);

    const res = await request(buildApp()).get("/og/producto/5").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.text).toContain("<h2>Llevalo en combo y ahorrá</h2>");
    expect(res.text).toContain("<h3>Kit Living Cálido</h3>");
    expect(res.text).toContain("<p>Precio combo $38.250</p>");
    // La consulta es la de la ficha: los combos que incluyen ESTE producto.
    expect(comboItemFindManyMock.mock.calls[0][0].where.productId).toBe(5);
  });
});

describe("GET /og/combo/:idSlug", () => {
  it("bot + combo vigente: 200 indexable, canonical con rutaCombo, hero como og:image y el cuerpo de la página", async () => {
    comboFindUniqueMock.mockResolvedValue(comboCompleto());

    const res = await request(buildApp()).get("/og/combo/3").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).not.toContain("noindex");
    expect(res.text).toContain("<title>Kit Living Cálido — YIMA</title>");
    expect(res.text).toContain('<link rel="canonical" href="https://yima.example.com/combos/3-kit-living-calido" />');
    expect(res.text).toContain('content="https://res.cloudinary.com/demo/hero-kit.jpg"');
    expect(res.text).toContain('name="description" content="Luz suave y una mesa de roble."');
    expect(res.text).toContain("<h1>Kit Living Cálido</h1>");
    expect(res.text).toContain("<h2>Juntos te salen $6.750 menos</h2>");
    expect(comboFindUniqueMock.mock.calls[0][0].where).toEqual({ id: 3 });
  });

  it("sin hero, og:image cae al PNG por defecto", async () => {
    comboFindUniqueMock.mockResolvedValue(comboCompleto({ heroUrl: null }));

    const res = await request(buildApp()).get("/og/combo/3").set("User-Agent", UA_BOT);

    expect(res.text).toContain('content="https://yima.example.com/og-default.png"');
  });

  it("agotado sigue siendo 200 indexable, con el chip Agotado", async () => {
    comboFindUniqueMock.mockResolvedValue(conStock(comboCompleto(), 0));

    const res = await request(buildApp()).get("/og/combo/3-kit-living-calido").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("noindex");
    expect(res.text).toContain("<p>Agotado</p>");
  });

  it("apagado: 404 + noindex", async () => {
    comboFindUniqueMock.mockResolvedValue(comboCompleto({ activo: false }));

    const res = await request(buildApp()).get("/og/combo/3").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(res.text).toContain('content="noindex, follow"');
    expect(res.text).not.toContain("Kit Living Cálido");
  });

  it("de campaña sin campaña en fecha: 404 + noindex", async () => {
    comboFindUniqueMock.mockResolvedValue(comboCompleto({ vigencia: "CAMPANIA", campanias: [] }));

    const res = await request(buildApp()).get("/og/combo/3").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(res.text).toContain('content="noindex, follow"');
  });

  it("inexistente: 404 + noindex", async () => {
    comboFindUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/og/combo/999").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(res.text).toContain('content="noindex, follow"');
  });

  it("id no numérico: 404 sin tocar la base", async () => {
    const res = await request(buildApp()).get("/og/combo/kit").set("User-Agent", UA_BOT);

    expect(res.status).toBe(404);
    expect(comboFindUniqueMock).not.toHaveBeenCalled();
  });

  it("una persona va a la página real con slug", async () => {
    comboFindUniqueMock.mockResolvedValue(comboCompleto());

    const res = await request(buildApp()).get("/og/combo/3").set("User-Agent", UA_NAVEGADOR);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://yima.example.com/combos/3-kit-living-calido");
  });

  it("una persona con un combo no vigente va a /combos", async () => {
    comboFindUniqueMock.mockResolvedValue(null);

    const res = await request(buildApp()).get("/og/combo/999").set("User-Agent", UA_NAVEGADOR);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://yima.example.com/combos");
  });
});

describe("GET /og/combos", () => {
  it("bot: 200 con las cards de los combos vigentes enlazadas con rutaCombo", async () => {
    comboFindManyMock.mockResolvedValueOnce([comboCompleto()]);

    const res = await request(buildApp()).get("/og/combos").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain("noindex");
    expect(res.text).toContain("<title>Combos — YIMA</title>");
    expect(res.text).toContain('<link rel="canonical" href="https://yima.example.com/combos" />');
    // El mismo encabezado que `CatalogoCombos.jsx`, con los números de `resumenCombos`.
    expect(res.text).toContain("<p>Combos</p><h1>Llevá el set completo y pagá menos</h1>");
    expect(res.text).toContain("<p>Productos elegidos para usarse juntos, con un descuento que solo tenés comprando el combo.</p>");
    // Dos textos separados, como los dos <span> de la página: sin un "·" que la persona no ve.
    expect(res.text).toContain("<p>Hasta 15% off</p><p>1 combo disponible</p>");
    expect(res.text).not.toContain("·");
    expect(res.text).toContain('<h3><a href="https://yima.example.com/combos/3-kit-living-calido">Kit Living Cálido</a></h3>');
    const [args] = comboFindManyMock.mock.calls[0];
    expect(args.where.activo).toBe(true);
    expect(args.where.OR[0]).toEqual({ vigencia: "SIEMPRE" });
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("bot sin combos: el mismo vacío que CatalogoCombos.jsx", async () => {
    const res = await request(buildApp()).get("/og/combos").set("User-Agent", UA_BOT);

    expect(res.status).toBe(200);
    expect(res.text).toContain("<h2>Upss, nos agarraste, estamos preparando nuevos combos para vos!</h2>");
    expect(res.text).toContain("<p>Muy pronto los vas a ver acá!</p>");
    // Sin combos, el encabezado va sin la línea de datos, igual que en la página.
    expect(res.text).toContain("<h1>Llevá el set completo y pagá menos</h1>");
    expect(res.text).not.toContain("Hasta ");
    expect(res.text).toContain('<a href="https://yima.example.com/coleccion">Mientras tanto, mirá los productos</a>');
  });

  it("una persona va a /combos", async () => {
    const res = await request(buildApp()).get("/og/combos").set("User-Agent", UA_NAVEGADOR);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://yima.example.com/combos");
  });
});
