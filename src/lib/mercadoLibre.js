/**
 * Cliente de la API oficial de MercadoLibre, usado por los scripts de
 * generación de fichas. Se usa la API y no scraping del HTML porque el sitio
 * renderiza del lado del cliente y tiene protección anti-bot; la API devuelve
 * datos estructurados y estables.
 *
 * IMPORTANTE: los datos que devuelve son INSUMO DE HECHOS. Las publicaciones
 * que se consultan no son del dueño del catálogo, así que su redacción y sus
 * fotos no se copian nunca — ver el spec del 2026-08-19.
 */

/**
 * Saca el id de ítem (`MLA...`) de una URL de MercadoLibre.
 *
 * ML tiene varias formas de URL para lo mismo (artículo con guion, producto de
 * catálogo sin guion, con query params de tracking), así que se busca el
 * patrón en cualquier parte del texto en vez de parsear la ruta.
 *
 * @returns {string|null} el id normalizado sin guion, o null si no hay ninguno
 */
export function extraerIdML(url) {
  if (!url) return null;

  const match = String(url).match(/\b(ML[A-Z])-?(\d+)\b/);
  return match ? `${match[1]}${match[2]}` : null;
}

const URL_BASE = "https://api.mercadolibre.com";

/** Margen de seguridad para renovar el token antes de que expire de verdad. */
const MARGEN_EXPIRACION_MS = 60_000;

/**
 * Cliente con el token cacheado en memoria.
 *
 * `fetch` se inyecta para poder testear sin red. El token se guarda en la
 * clausura y no en un módulo global: cada corrida del script crea el suyo, y
 * los tests no se contaminan entre sí.
 */
export function crearClienteML({ clientId, clientSecret, fetch: fetchFn = globalThis.fetch }) {
  let token = null;
  let expiraEn = 0;

  async function obtenerToken() {
    if (token && Date.now() < expiraEn) return token;

    const respuesta = await fetchFn(`${URL_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });

    if (!respuesta.ok) {
      const cuerpo = await respuesta.json().catch(() => ({}));
      throw new Error(
        `MercadoLibre rechazó las credenciales (HTTP ${respuesta.status}): ${cuerpo.message ?? "sin detalle"}. Revisá ML_CLIENT_ID y ML_CLIENT_SECRET.`,
      );
    }

    const datos = await respuesta.json();
    token = datos.access_token;
    expiraEn = Date.now() + datos.expires_in * 1000 - MARGEN_EXPIRACION_MS;
    return token;
  }

  return { obtenerToken };
}
