/**
 * La ÚNICA casa de los colores de etiqueta.
 *
 * POR QUÉ ACÁ Y NO EN TOKENS DE TAILWIND. El sistema de diseño tiene 34 tokens
 * de color, pero solo OCHO sirven como fondo de chip: los que tienen su `on-`
 * de pareja. Una paleta de 20 con tokens exigiría definirlos en tres archivos
 * (`:root`, `[data-tema-admin="oscuro"]` y `tailwind.config.js`) — el patrón de
 * tres casas que se borró el 06/09/2026 con el selector de color del slide.
 *
 * CÓMO VIAJA. `Etiqueta.color` guarda el `id`; el mapper resuelve y emite
 * `colorFondo`/`colorTexto` ya hechos, y el frontend pinta con `style` inline.
 * El frontend NO tiene copia de esta lista: la recibe por
 * `GET /etiquetas/opciones`, mismo criterio que `GET /ordenes/estados`.
 *
 * EN CANALES, NUNCA EN HEX. Es la invariante de color del proyecto.
 *
 * CONTRASTE. Los 20 pasan WCAG AA (≥ 4.5) entre su texto y su fondo, y se
 * distinguen de las dos superficies (claro `255 248 245`, oscuro `22 19 15`).
 * El guard vive en `coloresEtiqueta.test.js` y **hay que correrlo antes de
 * sumar un color**: tres candidatos de la primera tanda fallaron. No hay negro
 * en la lista porque ningún negro puede distinguirse del admin oscuro; el rol
 * de "oscuro premium" lo cubre CACAO.
 */
export const COLORES_ETIQUETA = [
  // De marca
  { id: "TERRACOTA", nombre: "Terracota", fondo: "157 62 29", texto: "255 255 255" },
  { id: "MUSGO", nombre: "Musgo", fondo: "88 99 48", texto: "255 255 255" },
  // No es el token `golden-sand` (`233 196 106`): ese daba 1.59 contra la
  // página crema, o sea invisible en la tabla del admin. Oscurecido a 1.86.
  { id: "ARENA", nombre: "Arena dorada", fondo: "223 180 78", texto: "61 47 0" },
  { id: "CACAO", nombre: "Cacao", fondo: "86 66 60", texto: "255 255 255" },
  // Cálidos
  { id: "CORAL", nombre: "Coral", fondo: "214 104 68", texto: "42 14 5" },
  { id: "ROJO", nombre: "Rojo", fondo: "186 26 26", texto: "255 255 255" },
  { id: "NARANJA", nombre: "Naranja", fondo: "194 65 12", texto: "255 255 255" },
  { id: "AMBAR", nombre: "Ámbar", fondo: "217 140 31", texto: "43 26 0" },
  { id: "OCRE", nombre: "Ocre", fondo: "115 88 2", texto: "255 255 255" },
  // Verdes
  { id: "OLIVA", nombre: "Oliva", fondo: "107 125 58", texto: "255 255 255" },
  { id: "VERDE", nombre: "Verde", fondo: "46 125 50", texto: "255 255 255" },
  { id: "JADE", nombre: "Jade", fondo: "15 118 110", texto: "255 255 255" },
  // Fríos
  { id: "PIZARRA", nombre: "Azul pizarra", fondo: "44 82 130", texto: "255 255 255" },
  { id: "CELESTE", nombre: "Celeste", fondo: "126 168 196", texto: "16 34 46" },
  { id: "INDIGO", nombre: "Índigo", fondo: "67 56 202", texto: "255 255 255" },
  { id: "VIOLETA", nombre: "Violeta", fondo: "109 40 217", texto: "255 255 255" },
  // Joya
  { id: "CIRUELA", nombre: "Ciruela", fondo: "123 45 94", texto: "255 255 255" },
  { id: "VINO", nombre: "Vino", fondo: "127 29 58", texto: "255 255 255" },
  { id: "ROSA", nombre: "Rosa", fondo: "194 24 91", texto: "255 255 255" },
  // Neutro. Oscurecido desde `138 114 107`, que daba 4.47 y fallaba WCAG por
  // tres centésimas.
  { id: "PIEDRA", nombre: "Piedra", fondo: "125 98 89", texto: "255 255 255" },
];

const POR_ID = new Map(COLORES_ETIQUETA.map((color) => [color.id, color]));

/**
 * Resuelve un id guardado a su color completo. Devuelve `null` cuando no hay
 * color elegido o cuando el id no existe — y `null` significa "se pinta como
 * siempre", no "error": la etiqueta cae al token por defecto de cada
 * superficie.
 */
export function resolverColorEtiqueta(id) {
  if (typeof id !== "string") return null;
  return POR_ID.get(id) ?? null;
}

/** Para la validación de escritura: un id fuera de la paleta es 400. */
export function esColorEtiquetaValido(id) {
  return typeof id === "string" && POR_ID.has(id);
}
