import { describe, expect, it } from "vitest";
import { truncarDescripcion, resolverImagenOg } from "./ogMeta.js";

describe("truncarDescripcion", () => {
  it("devuelve el texto tal cual si es más corto que el límite", () => {
    expect(truncarDescripcion("Un anillo de oro 18k.", 160)).toBe("Un anillo de oro 18k.");
  });

  it("devuelve el texto tal cual si mide exactamente el límite", () => {
    const texto = "a".repeat(160);
    expect(truncarDescripcion(texto, 160)).toBe(texto);
  });

  it("trunca en el límite de palabra más cercano, sin cortar una palabra a la mitad", () => {
    const texto = "Una pulsera artesanal de plata 950, hecha a mano por orfebres locales con más de veinte años de experiencia en la técnica de filigrana tradicional argentina.";
    const resultado = truncarDescripcion(texto, 60);
    expect(resultado.length).toBeLessThanOrEqual(61); // 60 + "…"
    expect(resultado.endsWith("…")).toBe(true);
    expect(resultado.slice(0, -1).endsWith(" ")).toBe(false);
    expect(texto.startsWith(resultado.slice(0, -1))).toBe(true);
  });

  it("devuelve string vacío para input vacío", () => {
    expect(truncarDescripcion("", 160)).toBe("");
  });
});

describe("resolverImagenOg", () => {
  const urls = { frontendUrl: "https://aura.example.com", backendUrl: "https://api.aura.example.com" };

  it("usa la URL de Cloudinary tal cual cuando fotos[0] tiene cloudinaryPublicId", () => {
    const producto = {
      id: 5,
      fotos: [{ id: 1, orden: 0, url: "https://res.cloudinary.com/demo/image/upload/v1/foto.jpg", cloudinaryPublicId: "foto", driveFileId: null }],
    };
    expect(resolverImagenOg(producto, urls)).toBe("https://res.cloudinary.com/demo/image/upload/v1/foto.jpg");
  });

  it("arma la URL del proxy del backend cuando fotos[0] es legacy Drive", () => {
    const producto = {
      id: 5,
      fotos: [{ id: 7, orden: 0, url: "irrelevante", cloudinaryPublicId: null, driveFileId: "abc123" }],
    };
    expect(resolverImagenOg(producto, urls)).toBe("https://api.aura.example.com/api/products/5/fotos/7");
  });

  it("usa la URL de placehold.co tal cual cuando fotos[0] es un placeholder seed", () => {
    const producto = {
      id: 5,
      fotos: [{ id: 9, orden: 0, url: "https://placehold.co/600x400", cloudinaryPublicId: null, driveFileId: null }],
    };
    expect(resolverImagenOg(producto, urls)).toBe("https://placehold.co/600x400");
  });

  it("respeta el orden ascendente cuando hay varias fotos", () => {
    const producto = {
      id: 5,
      fotos: [
        { id: 2, orden: 1, url: "https://res.cloudinary.com/demo/segunda.jpg", cloudinaryPublicId: "segunda", driveFileId: null },
        { id: 1, orden: 0, url: "https://res.cloudinary.com/demo/primera.jpg", cloudinaryPublicId: "primera", driveFileId: null },
      ],
    };
    expect(resolverImagenOg(producto, urls)).toBe("https://res.cloudinary.com/demo/primera.jpg");
  });

  it("cae al fallback del frontend cuando no hay fotos", () => {
    const producto = { id: 5, fotos: [] };
    expect(resolverImagenOg(producto, urls)).toBe("https://aura.example.com/og-default.png");
  });

  it("el fallback es un mapa de bits, nunca un SVG", () => {
    // Los scrapers de WhatsApp, Facebook, Twitter y LinkedIn no renderizan SVG
    // como og:image: la tarjeta sale sin imagen. Este camino tuvo ese bug, y
    // volver a un .svg lo reintroduce sin que nada más falle.
    expect(resolverImagenOg({ id: 5, fotos: [] }, urls)).toMatch(/\.(png|jpe?g|webp)$/i);
  });
});
