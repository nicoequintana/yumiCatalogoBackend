/**
 * Único módulo que conoce el webhook de n8n que genera las imágenes de producto.
 *
 * La URL y el token se leen de `process.env` en CADA llamada, no al importar:
 * los tests de rutas arrastran este módulo por la cadena de imports y no pueden
 * exigir un entorno completo. Mismo criterio perezoso que
 * `cloudinary.service.js` y `email.service.js`.
 *
 * Este servicio LANZA ante un fallo. Quién lo convierte en respuesta HTTP es el
 * controller — acá no se conoce Express.
 *
 * Node 22+ trae `fetch`, `FormData` y `Blob` nativos, así que armar el
 * multipart no suma ninguna dependencia.
 *
 * Contrato del flujo, en `docs/contrato-webhook-n8n-imagenes.md`.
 */

/**
 * Timeout del webhook. n8n responde de inmediato y sigue procesando aparte, así
 * que 15s es holgado; sin timeout, una conexión que no rechaza pero tampoco
 * responde deja al admin mirando un spinner para siempre.
 */
const TIMEOUT_MS = 15_000;

/**
 * Máximo de referencias aceptadas. Espejo del `maxCount` de multer en
 * `products.routes.js`: si se desincronizan, multer acepta un archivo que este
 * servicio después descarta en silencio.
 */
export const MAX_REFERENCIAS = 4;

/**
 * Nombre por defecto del header de autenticación. Se puede pisar con
 * `N8N_WEBHOOK_HEADER` porque lo define la credencial de n8n, no YIMA.
 */
const HEADER_AUTH_POR_DEFECTO = "X-API-Key";

/**
 * Nombres de los campos del FormData. Son el CONTRATO con el nodo Webhook de
 * n8n: cambiarlos no produce ningún error de este lado, solo un flujo que
 * recibe campos vacíos.
 */
const CAMPO_PRODUCTO = "producto";
const nombreDeReferencia = (indice) => `referencia_${indice + 1}`;

function leerEnv(nombre) {
  const valor = process.env[nombre];
  return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : null;
}

function urlDelWebhook() {
  return leerEnv("N8N_WEBHOOK_IMAGENES");
}

/**
 * Header de autenticación del webhook, o `{}` si no hay token configurado.
 *
 * El webhook de n8n está declarado con Header Auth: sin este header responde
 * 403 y el pedido nunca llega al flujo.
 */
function headersDeAuth() {
  const token = leerEnv("N8N_WEBHOOK_TOKEN");
  if (!token) return {};
  return { [leerEnv("N8N_WEBHOOK_HEADER") ?? HEADER_AUTH_POR_DEFECTO]: token };
}

/**
 * Permite que el controller responda un 400 explicativo en vez de fallar de
 * forma oscura cuando el deploy no tiene la variable cargada.
 */
export function estaConfigurado() {
  return urlDelWebhook() !== null;
}

/**
 * Envía el pedido de generación al webhook de n8n.
 *
 * @param {object} params
 * @param {object} params.producto objeto plano ya mapeado (`mapProductoParaN8n`)
 * @param {Array<{buffer: Buffer, originalname: string, mimetype: string}>} params.referencias al menos una
 * @returns {Promise<{estado: "processing"|"already_processed", sku?: string, carpeta?: string}>}
 */
export async function enviarPedidoDeImagenes({ producto, referencias = [] }) {
  const url = urlDelWebhook();
  if (!url) {
    throw new Error("La integración con n8n no está configurada (falta N8N_WEBHOOK_IMAGENES).");
  }

  const cuerpo = new FormData();
  cuerpo.append(CAMPO_PRODUCTO, JSON.stringify(producto));

  // ⚠️ EL ORDEN DE ESTOS `append` ES SIGNIFICATIVO Y NO ES INTERCAMBIABLE.
  // El nodo Webhook de n8n expone los binarios como `data0`, `data1`… EN ORDEN
  // DE APARICIÓN EN EL FORM, no por nombre de campo: los nombres
  // `referencia_1`/`referencia_2` son documentación para quien lee el request,
  // no lo que n8n usa para ordenarlos. Reordenar este bucle cambia cuál imagen
  // es la referencia principal sin que nada falle ni lo delate.
  referencias.slice(0, MAX_REFERENCIAS).forEach((archivo, indice) => {
    cuerpo.append(
      nombreDeReferencia(indice),
      new Blob([archivo.buffer], { type: archivo.mimetype }),
      archivo.originalname,
    );
  });

  let respuesta;
  try {
    respuesta = await fetch(url, {
      method: "POST",
      // Sin `Content-Type` a mano: lo pone `fetch` junto con el boundary del
      // multipart. Fijarlo rompe el parseo del otro lado.
      headers: headersDeAuth(),
      body: cuerpo,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const expiro = err?.name === "TimeoutError";
    throw new Error(
      expiro
        ? "n8n no respondió a tiempo. Revisá que el flujo esté activo."
        : `No se pudo contactar a n8n: ${err.message}`,
    );
  }

  if (respuesta.status === 401 || respuesta.status === 403) {
    // Un error genérico manda a revisar el flujo, que es el lugar equivocado:
    // la causa casi siempre es el token, y el mensaje tiene que decirlo.
    // NUNCA incluir el valor del token en el mensaje: este texto termina en la
    // pantalla del admin.
    throw new Error(
      "n8n rechazó la autenticación. Revisá que N8N_WEBHOOK_TOKEN coincida con la credencial Header Auth del webhook.",
    );
  }

  // n8n contesta JSON en todos sus caminos. Se parsea con tolerancia: un proxy
  // caído devuelve HTML, y un `JSON.parse` pelado convertiría eso en un
  // SyntaxError crudo en vez del error legible que este servicio promete.
  let cuerpoRespuesta = null;
  try {
    cuerpoRespuesta = JSON.parse(await respuesta.text());
  } catch {
    cuerpoRespuesta = null;
  }

  // `verification_failed`: n8n no pudo verificar contra Cloudinary si la
  // carpeta destino ya existía, y ABORTÓ sin generar ni subir nada. Es un
  // estado distinto de todos los demás y hay que tratarlo aparte:
  //   - no es un 400 (el payload está bien; reintentar el mismo pedido sirve)
  //   - no es un already_processed (no se llegó a saber si había algo hecho)
  //   - no es un fallo de configuración (el token y la URL están bien)
  // Se marca `esReintentable` para que el controller responda 503 y no 502.
  if (respuesta.status === 503 || cuerpoRespuesta?.status === "verification_failed") {
    const err = new Error(
      "n8n no pudo verificar el estado en Cloudinary y no generó nada. Probá de nuevo en un rato.",
    );
    err.esReintentable = true;
    throw err;
  }

  if (!respuesta.ok) {
    // El 400 de n8n trae el motivo concreto ("Missing required product fields:
    // descripcion", "at least one reference image is required"…). Mostrarlo le
    // ahorra al admin abrir el editor de n8n para enterarse de qué faltó.
    throw new Error(
      cuerpoRespuesta?.error
        ? `n8n rechazó el pedido: ${cuerpoRespuesta.error}`
        : `n8n rechazó el pedido (HTTP ${respuesta.status}).`,
    );
  }

  // `already_processed` NO es un error: n8n encontró la carpeta
  // `productos/{sku}` ya creada en Cloudinary y no regeneró nada. Tratarlo como
  // éxito a secas es peor que un error — el admin vería "enviado" y se quedaría
  // esperando imágenes que nunca se van a generar.
  return {
    estado: cuerpoRespuesta?.status === "already_processed" ? "already_processed" : "processing",
    sku: cuerpoRespuesta?.sku,
    carpeta: cuerpoRespuesta?.folder,
  };
}
