/**
 * Máximo de fotos por producto.
 *
 * El número tiene que ser el MISMO en tres capas que no se hablan entre sí:
 *
 * 1. `routes/products.routes.js` — el `maxCount` de multer, que corta la
 *    subida antes de que los bytes lleguen al controller.
 * 2. `controllers/products.controller.js` — la validación de negocio, que
 *    cuenta las fotos ya guardadas más las nuevas.
 * 3. `middlewares/errorHandler.js` — el mensaje que se le muestra al admin
 *    cuando multer rechaza el campo `fotos` con `LIMIT_UNEXPECTED_FILE`.
 *
 * Si se desincronizan, multer rechaza con un mensaje que dice otro número, o
 * peor: acepta más fotos de las que el controller admite y la request muere
 * después de subir archivos a Cloudinary.
 *
 * NO confundir con el tope de tamaño por archivo: los 15MB por foto contra los
 * 100MB globales de multer son un split deliberado (multer no sabe aplicar un
 * `fileSize` distinto por campo) y viven donde están, documentados.
 */
export const MAX_FOTOS = 10;
