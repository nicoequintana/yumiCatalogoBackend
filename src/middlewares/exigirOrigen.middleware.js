import { httpError } from "../lib/httpError.js";
import { parsearOrigenesCors } from "../lib/corsOrigen.js";

/**
 * Segunda capa contra CSRF (Amenaza 15 de la spec). La primera es
 * `SameSite=Strict` en la cookie; esta cubre navegadores viejos y cualquier
 * configuración que la relaje.
 *
 * Toda MUTACIÓN tiene que traer un `Origin` que esté en `CORS_ORIGIN`. Los
 * navegadores lo mandan siempre en POST/PUT/PATCH/DELETE. Un `curl` sin
 * `Origin` es rechazado: la superficie de cliente se usa desde el sitio, no
 * desde scripts. El camino Bearer del admin no pasa por acá.
 *
 * La comparación es EXACTA sobre el string del origen: esquema + host +
 * puerto. `startsWith` dejaría pasar `https://yima-productos.com.atacante.com`.
 */

const METODOS_SEGUROS = new Set(["GET", "HEAD", "OPTIONS"]);

export function crearExigirOrigen({ origenesPermitidos }) {
  const permitidos = new Set(origenesPermitidos.map((o) => String(o).trim()).filter(Boolean));
  return function exigirOrigen(req, _res, next) {
    if (METODOS_SEGUROS.has(req.method)) return next();
    const origen = req.get("Origin");
    if (!origen || origen === "null" || !permitidos.has(origen)) {
      const err = httpError(403, "Origen no permitido.");
      err.codigo = "ORIGEN_RECHAZADO";
      return next(err);
    }
    next();
  };
}

// `parsearOrigenesCors` siempre devuelve `string[]`: es la misma lista que
// recibe `cors()` en `server.js`, así que las dos capas aceptan exactamente
// los mismos orígenes.
export const exigirOrigen = crearExigirOrigen({
  origenesPermitidos: parsearOrigenesCors(process.env.CORS_ORIGIN),
});
