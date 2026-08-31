import { describe, expect, it } from "vitest";
import { detectarTipoDeMedia, contenidoCoincideConMime } from "./magicBytes.js";

// Buffers mínimos con los bytes de firma reales de cada formato. Solo importan
// los primeros bytes; el resto del archivo es irrelevante para la detección.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP = Buffer.from([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x24, 0x00, 0x00, 0x00, // tamaño (irrelevante)
  0x57, 0x45, 0x42, 0x50, // "WEBP"
]);
const MP4 = Buffer.from([
  0x00, 0x00, 0x00, 0x18, // tamaño de la box
  0x66, 0x74, 0x79, 0x70, // "ftyp" en el offset 4
  0x6d, 0x70, 0x34, 0x32, // "mp42"
]);
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00]);

describe("detectarTipoDeMedia", () => {
  it("reconoce JPEG por FF D8 FF", () => {
    expect(detectarTipoDeMedia(JPEG)).toBe("image/jpeg");
  });

  it("reconoce PNG por su firma de 8 bytes", () => {
    expect(detectarTipoDeMedia(PNG)).toBe("image/png");
  });

  it("reconoce WEBP por RIFF....WEBP", () => {
    expect(detectarTipoDeMedia(WEBP)).toBe("image/webp");
  });

  it("reconoce MP4 por la box ftyp en el offset 4", () => {
    expect(detectarTipoDeMedia(MP4)).toBe("video/mp4");
  });

  it("reconoce WEBM por 1A 45 DF A3", () => {
    expect(detectarTipoDeMedia(WEBM)).toBe("video/webm");
  });

  it("devuelve null ante un buffer vacío", () => {
    expect(detectarTipoDeMedia(Buffer.alloc(0))).toBeNull();
  });

  it("devuelve null ante un buffer demasiado corto para una firma", () => {
    expect(detectarTipoDeMedia(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it("devuelve null ante bytes desconocidos", () => {
    expect(detectarTipoDeMedia(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]))).toBeNull();
  });

  it("devuelve null si no le pasan un Buffer", () => {
    expect(detectarTipoDeMedia("no soy un buffer")).toBeNull();
    expect(detectarTipoDeMedia(null)).toBeNull();
    expect(detectarTipoDeMedia(undefined)).toBeNull();
  });

  it("un WEBP truncado antes del fourcc WEBP no se confunde con imagen", () => {
    // "RIFF" pero sin los bytes "WEBP" en el offset 8 (podría ser un WAV).
    const riffNoWebp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]);
    expect(detectarTipoDeMedia(riffNoWebp)).toBeNull();
  });
});

describe("contenidoCoincideConMime", () => {
  it("acepta cuando los bytes coinciden con el mimetype declarado", () => {
    expect(contenidoCoincideConMime(JPEG, "image/jpeg")).toBe(true);
    expect(contenidoCoincideConMime(PNG, "image/png")).toBe(true);
    expect(contenidoCoincideConMime(WEBP, "image/webp")).toBe(true);
    expect(contenidoCoincideConMime(MP4, "video/mp4")).toBe(true);
    expect(contenidoCoincideConMime(WEBM, "video/webm")).toBe(true);
  });

  it("rechaza un MIME mentido (bytes PNG declarados como JPEG)", () => {
    expect(contenidoCoincideConMime(PNG, "image/jpeg")).toBe(false);
  });

  it("rechaza contenido ejecutable disfrazado de imagen", () => {
    // Un script/HTML declarado como imagen: sus bytes no son ninguna firma.
    const html = Buffer.from("<script>alert(1)</script>", "utf8");
    expect(contenidoCoincideConMime(html, "image/png")).toBe(false);
  });

  it("rechaza un buffer vacío o corto", () => {
    expect(contenidoCoincideConMime(Buffer.alloc(0), "image/jpeg")).toBe(false);
    expect(contenidoCoincideConMime(Buffer.from([0xff]), "image/jpeg")).toBe(false);
  });
});
