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

  const texto = String(url);

  // Las URLs de catálogo (/p/MLA..., /up/MLAU...) llevan en el path el id del
  // PRODUCTO de catálogo, que no sirve (la API de catálogo está cerrada para
  // apps comunes). La publicación concreta viaja en parámetros: `wid=` o
  // `item_id:` (a veces con los dos puntos URL-encodeados como %3A). Si están,
  // mandan sobre cualquier id del path — si no, un /p/MLA<numérico> haría
  // matchear primero el id equivocado.
  const explicito = texto.match(/(?:wid=|item_id(?::|%3[Aa]))(ML[A-Z])-?(\d+)\b/);
  if (explicito) return `${explicito[1]}${explicito[2]}`;

  const match = texto.match(/\b(ML[A-Z])-?(\d+)\b/);
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

    // Mismo contrato de errores que `pedir`: un fetch rechazado acá salía como
    // TypeError crudo — el único endpoint que quedaba sin contextualizar.
    let respuesta;
    try {
      respuesta = await fetchFn(`${URL_BASE}/oauth/token`, {
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
    } catch (err) {
      throw new Error(`No se pudo conectar con MercadoLibre (/oauth/token): ${err.message}`);
    }

    if (!respuesta.ok) {
      const cuerpo = await respuesta.json().catch(() => ({}));
      throw new Error(
        `MercadoLibre rechazó las credenciales (HTTP ${respuesta.status}): ${cuerpo.message ?? "sin detalle"}. Revisá ML_CLIENT_ID y ML_CLIENT_SECRET.`,
      );
    }

    const datos = await respuesta.json().catch(() => {
      throw new Error("MercadoLibre devolvió una respuesta inválida al pedir el token.");
    });
    token = datos.access_token;
    expiraEn = Date.now() + datos.expires_in * 1000 - MARGEN_EXPIRACION_MS;
    return token;
  }

  /**
   * Un 401 a mitad de lote significa que el token se invalidó antes de su
   * vencimiento declarado. Se descarta el cacheado y se reintenta UNA vez, en
   * vez de marcar la fila como fallada por algo que se arregla solo.
   */
  async function pedir(ruta) {
    // El token se pide ANTES del try/catch a propósito: si obtenerToken()
    // falla (credenciales, respuesta inválida), ese error ya viene con
    // contexto propio y no debe disfrazarse de fallo de red.
    const conToken = async () => {
      const tok = await obtenerToken();
      try {
        return await fetchFn(`${URL_BASE}${ruta}`, {
          headers: { Authorization: `Bearer ${tok}` },
        });
      } catch (err) {
        // fetch rechazado (sin conexión, DNS, timeout...): un TypeError crudo
        // no le sirve al operador para entender qué pasó con la fila.
        throw new Error(`No se pudo conectar con MercadoLibre (${ruta}): ${err.message}`);
      }
    };

    const respuesta = await conToken();
    if (respuesta.status !== 401) return respuesta;

    token = null;
    return conToken();
  }

  /**
   * Trae los HECHOS de una publicación.
   *
   * Verificado 2026-08-19 con credenciales reales: ML devuelve 403 en
   * /items/{id} de publicaciones de terceros con cualquier tipo de token; la
   * única fuente abierta es /items/{id}/description. Por eso el dossier es
   * descripción-primero: /items se intenta igual (si ML habilita permisos a
   * la app, esto se enriquece solo) pero su falla NO es un error de fila.
   * La fila falla únicamente cuando ninguna de las dos fuentes responde.
   */
  async function traerDossier(id) {
    const respuestaItem = await pedir(`/items/${id}`);
    // Un 200 con JSON malformado se trata igual que un 403: se degrada a
    // "sin ítem" en vez de tirar el SyntaxError crudo del .json().
    const item = respuestaItem.ok ? await respuestaItem.json().catch(() => null) : null;

    const respuestaDesc = await pedir(`/items/${id}/description`);
    const cuerpoDesc = respuestaDesc.ok ? await respuestaDesc.json().catch(() => ({})) : {};
    const descripcionML = cuerpoDesc.plain_text ?? "";

    // La condición mira el HECHO (¿hay título o descripción utilizable?), no
    // el HTTP crudo: una descripción 200 con JSON roto no es "utilizable"
    // aunque respuestaDesc.ok sea true.
    if (!item && descripcionML === "") {
      throw new Error(
        `No se pudo leer nada útil de ${id}: /items dio HTTP ${respuestaItem.status} y /description dio HTTP ${respuestaDesc.status}.`,
      );
    }

    return {
      titulo: item?.title ?? null,
      precioML: item?.price ?? null,
      atributos: (item?.attributes ?? [])
        .filter((atributo) => atributo.value_name)
        .map((atributo) => ({ nombre: atributo.name, valor: atributo.value_name })),
      descripcionML,
    };
  }

  return { obtenerToken, traerDossier };
}
