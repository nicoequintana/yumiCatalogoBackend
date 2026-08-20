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

/**
 * Máximo de videos por producto.
 *
 * Mismo problema de sincronización que `MAX_FOTOS`, en dos capas:
 *
 * 1. `routes/products.routes.js` — el `maxCount` del campo `video` de multer.
 * 2. `middlewares/errorHandler.js` — el mensaje que ve el admin cuando multer
 *    rechaza ese campo con `LIMIT_UNEXPECTED_FILE`.
 *
 * No hay una tercera capa de validación de negocio como en las fotos porque el
 * tope está además garantizado por el schema: `Video.productId` es `@unique`,
 * o sea una relación 1:1 con el producto. Multer es la primera barrera y la
 * base es la última.
 */
export const MAX_VIDEOS = 1;
