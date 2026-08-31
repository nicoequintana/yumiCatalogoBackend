/**
 * Verificación de "magic bytes" (content sniffing) de los medios que se suben.
 *
 * **Por qué existe.** Los `fileFilter` de multer validan `file.mimetype`, que es
 * el Content-Type que DECLARA el cliente — trivial de falsificar. Un atacante
 * puede subir un `.html` o un ejecutable rotulándolo `image/png` y pasar el
 * filtro. Esta es la defensa en profundidad: mira los PRIMEROS BYTES reales del
 * archivo (ya en memoria, porque multer usa `memoryStorage`) y confirma que
 * corresponden a un formato permitido ANTES de subirlo a Cloudinary.
 *
 * Sin dependencias nuevas: las firmas se comparan a mano.
 *
 * Firmas soportadas (las mismas que aceptan los `fileFilter` del proyecto):
 *   - JPEG  `FF D8 FF`
 *   - PNG   `89 50 4E 47 0D 0A 1A 0A`
 *   - WEBP  `RIFF` (offset 0) + `WEBP` (offset 8)
 *   - MP4   box `ftyp` (offset 4)
 *   - WEBM  `1A 45 DF A3` (cabecera EBML)
 */

const FIRMAS = {
  "image/jpeg": [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  "image/png": [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  // WEBP es un contenedor RIFF: "RIFF" al inicio y el fourcc "WEBP" en el
  // offset 8. Chequear solo "RIFF" confundiría un WAV/AVI con una imagen.
  "image/webp": [
    { offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] }, // "RIFF"
    { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // "WEBP"
  ],
  // La box `ftyp` empieza en el offset 4 (los primeros 4 bytes son su tamaño).
  "video/mp4": [{ offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] }], // "ftyp"
  "video/webm": [{ offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] }],
};

/** ¿El buffer tiene `bytes` exactamente a partir de `offset`? */
function coincideEn(buffer, offset, bytes) {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Detecta el tipo de medio de un buffer a partir de su firma de bytes.
 *
 * @param {Buffer} buffer contenido del archivo (multer memoryStorage)
 * @returns {string|null} el mimetype detectado, o `null` si no reconoce ninguno
 */
export function detectarTipoDeMedia(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;

  for (const [mime, partes] of Object.entries(FIRMAS)) {
    if (partes.every((parte) => coincideEn(buffer, parte.offset, parte.bytes))) {
      return mime;
    }
  }
  return null;
}

/**
 * ¿El contenido real del buffer corresponde al mimetype DECLARADO?
 *
 * Devuelve `false` cuando los bytes no matchean ninguna firma conocida (buffer
 * vacío, corto o de un tipo distinto) o cuando matchean una firma pero de OTRO
 * tipo que el declarado — que es exactamente el caso de un MIME falsificado.
 *
 * @param {Buffer} buffer contenido del archivo
 * @param {string} mimeDeclarado el `file.mimetype` que informó el cliente
 * @returns {boolean}
 */
export function contenidoCoincideConMime(buffer, mimeDeclarado) {
  const detectado = detectarTipoDeMedia(buffer);
  return detectado !== null && detectado === mimeDeclarado;
}
