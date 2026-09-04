import { describe, expect, it } from "vitest";
import { urlDeFoto } from "./fotos.js";

/**
 * Guard de la URL pública de una foto.
 *
 * Lo que se prueba no es el `return` —es uno solo— sino la REGLA: se emite la
 * URL guardada, venga del storage que venga. Hasta el retiro de Drive había una
 * rama que ruteaba las fotos legadas por un proxy propio del backend; esa ruta
 * ya no existe y devolverla sería un 404 en la grilla pública.
 */
describe("urlDeFoto", () => {
  it("una foto de Cloudinary emite su URL guardada", () => {
    const foto = {
      id: 1,
      url: "https://res.cloudinary.com/yima/image/upload/v1/productos/7-termo/a.webp",
      orden: 0,
      cloudinaryPublicId: "productos/7-termo/a",
    };

    expect(urlDeFoto(foto)).toBe(
      "https://res.cloudinary.com/yima/image/upload/v1/productos/7-termo/a.webp",
    );
  });

  it("una foto legada sin cloudinaryPublicId emite su URL guardada, NUNCA una ruta de la API", () => {
    // El proxy `/api/products/:id/fotos/:fotoId` se eliminó el 02/09/2026 junto
    // con el retiro de Drive: cualquier fallback a una ruta propia responde 404.
    const legada = {
      id: 2,
      url: "https://drive.google.com/uc?id=1AbC",
      orden: 1,
      cloudinaryPublicId: null,
    };

    expect(urlDeFoto(legada)).toBe("https://drive.google.com/uc?id=1AbC");
  });

  it("una fila de seed sin ninguna columna de storage conserva su URL original", () => {
    const seed = { id: 3, url: "https://placehold.co/600x600.png", orden: 2 };

    expect(urlDeFoto(seed)).toBe("https://placehold.co/600x600.png");
  });
});
