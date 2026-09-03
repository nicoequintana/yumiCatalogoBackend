/**
 * Forma de lectura de un producto: el `include` de Prisma que trae todas sus
 * relaciones y el mapeo de esa fila a la forma que devuelve la API.
 *
 * Vive separado del controller porque lo consumen varios controllers de
 * producto (el principal y el de importación) y no depende de nada más: es
 * puro, sin acceso a base ni a storage.
 */

import { calcularPrecio, estadoDePrecio } from "../lib/precios.js";

export const PRODUCT_INCLUDE = {
  caracteristicas: true,
  fotos: { orderBy: { orden: "asc" } },
  video: true,
  categoria: true,
  listas: { orderBy: { orden: "asc" } },
  especificaciones: { orderBy: { orden: "asc" } },
};

/**
 * Forma de lectura del LISTADO, deliberadamente distinta de `PRODUCT_INCLUDE`.
 *
 * `GET /products` alimenta la grilla de `/coleccion`, el bento de destacados,
 * las tablas del admin y los "relacionados" del detalle. Ninguno de esos
 * consumidores lee la descripción larga, el contenido comercial, las listas,
 * las especificaciones, el video ni las fotos 2..10 — pero `PRODUCT_INCLUDE`
 * los traía igual, incluidas las tres columnas `NVarChar(Max)`
 * (`descripcion`, `porQueLoVasAQuerer`, `tePasaEsto`) y hasta 10 filas de
 * `Foto` por producto, multiplicado por todo el catálogo.
 *
 * Es un `select` y no un `include` a propósito: `include` trae SIEMPRE todas
 * las columnas escalares de la tabla, así que no habría forma de dejar afuera
 * las columnas `Max`.
 *
 * `fotos` va con `take: 1` porque la única foto que la grilla muestra es la
 * portada (`fotos[0]`, ver CLAUDE.md "las dos primeras fotos no son
 * intercambiables"). `cloudinaryPublicId` se selecciona porque `urlDeFoto` lo
 * necesita para resolver la URL; no se expone en la respuesta.
 *
 * `_count.fotos` conserva el "N/10" de la tabla del admin, que es lo único
 * que se perdía al recortar `fotos` a una sola fila.
 */
export const LIST_SELECT = {
  id: true,
  sku: true,
  nombre: true,
  precio: true,
  // Se seleccionan siempre, pero `mapProductoListado` los emite SOLO para
  // admin — ver `camposDePrecio`. Traerlos de más cuesta dos columnas
  // numéricas; no traerlos obligaría a un segundo `select` para la pantalla de
  // precios, que es el consumidor principal de este listado en el panel.
  costo: true,
  coeficiente: true,
  etiqueta: true,
  visibleEnCatalogo: true,
  stock: true,
  destacado: true,
  vistas: true,
  compartidos: true,
  categoria: { select: { id: true, nombre: true } },
  fotos: {
    select: { id: true, url: true, orden: true, cloudinaryPublicId: true },
    orderBy: { orden: "asc" },
    take: 1,
  },
  _count: { select: { fotos: true } },
};

/**
 * Resuelve la URL pública de una foto.
 *
 * `foto.url` ya contiene la URL directa del CDN de Cloudinary para todo lo
 * subido por el catálogo. Las filas de seed/placeholder tampoco tienen
 * `cloudinaryPublicId` y conservan su URL original, así que el mismo `return`
 * las cubre.
 *
 * Antes había una rama intermedia que ruteaba las fotos legadas de Google Drive
 * por un proxy propio del backend (una URL cruda de Drive dispara
 * `net::ERR_BLOCKED_BY_ORB` en Chromium por el Content-Type ambiguo de su
 * redirect). Ese storage se retiró del proyecto: no quedaba ninguna foto
 * apoyada en él —327 de 327 en producción salen de Cloudinary— y sostenerlo
 * costaba 208 MB de dependencia en la imagen del contenedor.
 *
 * Sigue compartida por `mapProducto` y `mapProductoListado` —aunque hoy sea un
 * solo `return`— para que la portada de la grilla y la galería del detalle no
 * puedan divergir si vuelve a aparecer un segundo storage.
 *
 * Se exporta desde que apareció un TERCER consumidor: `ordenes.mapper.js`, que
 * emite la portada de cada línea del detalle de una orden. Escribirla ahí como
 * `item.product?.fotos?.[0]?.url` sería la cuarta copia de la misma regla, y el
 * único de los tres lugares que no se enteraría del día que vuelva un segundo
 * storage. Si aparece un cuarto consumidor, mudarla a `lib/fotos.js`.
 */
export function urlDeFoto(foto) {
  return foto.url;
}


/**
 * Los cuatro campos de costeo, o nada.
 *
 * **`GET /products` y `GET /products/:id` son PÚBLICOS** (`authOpcional`, para
 * que el catálogo siga sirviendo a visitantes anónimos). Emitir `costo` sin
 * mirar quién pregunta filtraría al mundo entero lo que el negocio paga por su
 * mercadería — y encima en el endpoint que alimenta la grilla pública, o sea a
 * un `fetch` de distancia. Por eso van detrás del mismo flag que decide ver
 * ocultos y agotados (`esRequestDeAdmin`, `auth.middleware.js`).
 *
 * `precioCalculado` y `estadoPrecio` se derivan acá y no se persisten: no hay
 * columna de estado, así que no puede quedar desactualizado.
 *
 * `precioCalculado` es `null` —nunca "0"— cuando falta costo o coeficiente. Un
 * 0 se escribiría como precio del producto.
 */
function camposDePrecio(producto, esAdmin) {
  if (!esAdmin) return null;

  const calculado = calcularPrecio(producto.costo, producto.coeficiente);
  return {
    costo: producto.costo?.toString() ?? null,
    coeficiente: producto.coeficiente?.toString() ?? null,
    precioCalculado: calculado === null ? null : calculado.toString(),
    estadoPrecio: estadoDePrecio({
      precio: producto.precio,
      costo: producto.costo,
      coeficiente: producto.coeficiente,
    }),
  };
}

/**
 * Mapea una fila leída con `LIST_SELECT` a la forma que devuelve el listado.
 *
 * Es un subconjunto estricto de `mapProducto`: cada clave que emite existe
 * también en el detalle y con el mismo significado, así que un componente
 * como `ProductCard` funciona con las dos respuestas sin ramificar.
 *
 * `esAdmin` gobierna los campos de costeo — ver `camposDePrecio`. Su default es
 * `false` a propósito: si alguien agrega un llamador nuevo y se olvida de
 * pasarlo, el modo de falla es "faltan datos en el panel", nunca "el costo se
 * publicó".
 */
export function mapProductoListado(producto, { esAdmin = false } = {}) {
  return {
    ...camposDePrecio(producto, esAdmin),
    id: producto.id,
    sku: producto.sku,
    nombre: producto.nombre,
    precio: producto.precio.toString(),
    etiqueta: producto.etiqueta,
    categoria: producto.categoria ? { id: producto.categoria.id, nombre: producto.categoria.nombre } : null,
    vistas: producto.vistas,
    compartidos: producto.compartidos,
    visibleEnCatalogo: producto.visibleEnCatalogo,
    stock: producto.stock,
    destacado: producto.destacado,
    cantidadFotos: producto._count?.fotos ?? producto.fotos.length,
    fotos: producto.fotos.map((f) => ({
      id: f.id,
      url: urlDeFoto(f),
      orden: f.orden,
    })),
  };
}

function agruparListasPorTipo(listas) {
  const porTipo = { BENEFICIO: [], USO: [], IDEAL_PARA: [], INCLUYE: [] };
  for (const item of listas) {
    porTipo[item.tipo]?.push({ id: item.id, texto: item.texto });
  }
  return porTipo;
}

export function mapProducto(producto, { esAdmin = false } = {}) {
  // Una sola pasada por `listas` para las cuatro claves. Antes se llamaba a
  // `agruparListasPorTipo` una vez por clave y se descartaban las otras tres
  // agrupaciones, o sea cuatro recorridos completos por producto. Hoy este
  // mapper solo corre sobre el detalle (el listado usa `mapProductoListado`,
  // que ni siquiera trae `listas`), pero la pasada única sigue siendo la
  // forma correcta de agrupar.
  const listasPorTipo = agruparListasPorTipo(producto.listas ?? []);

  return {
    // Costo y coeficiente solo para admin — ver `camposDePrecio`. Este mapper
    // también sirve al detalle público de la ficha.
    ...camposDePrecio(producto, esAdmin),
    id: producto.id,
    sku: producto.sku,
    nombre: producto.nombre,
    descripcion: producto.descripcion,
    precio: producto.precio.toString(),
    etiqueta: producto.etiqueta,
    categoria: producto.categoria ? { id: producto.categoria.id, nombre: producto.categoria.nombre } : null,
    vistas: producto.vistas,
    compartidos: producto.compartidos,
    favoritosCount: producto.favoritosCount,
    visibleEnCatalogo: producto.visibleEnCatalogo,
    stock: producto.stock,
    destacado: producto.destacado,
    caracteristicas: producto.caracteristicas.map((c) => ({ id: c.id, texto: c.texto })),
    fraseComercial: producto.fraseComercial,
    porQueLoVasAQuerer: producto.porQueLoVasAQuerer,
    tePasaEsto: producto.tePasaEsto,
    beneficios: listasPorTipo.BENEFICIO,
    usos: listasPorTipo.USO,
    idealPara: listasPorTipo.IDEAL_PARA,
    incluye: listasPorTipo.INCLUYE,
    especificaciones: (producto.especificaciones ?? []).map((e) => ({ id: e.id, nombre: e.nombre, valor: e.valor })),
    // `cloudinaryPublicId` NO se expone: la URL de arriba ya viene resuelta del
    // lado del servidor, así que mandarlo solo filtraría un identificador
    // interno de storage en un endpoint público. Ningún cliente lo lee.
    // Mismo campo que emite `mapProductoListado`. Existe también acá para que
    // la tabla del admin pueda leer siempre `cantidadFotos`, incluso cuando la
    // fila del listado se reemplaza por la respuesta de un PATCH de
    // visibilidad/merchandising (que devuelve el producto completo).
    cantidadFotos: producto.fotos.length,
    fotos: producto.fotos.map((f) => ({
      id: f.id,
      url: urlDeFoto(f),
      orden: f.orden,
    })),
    video: producto.video
      ? {
          id: producto.video.id,
          url: producto.video.cloudinaryPublicId
            ? producto.video.url
            : `/api/products/${producto.id}/video`,
        }
      : null,
    createdAt: producto.createdAt,
    updatedAt: producto.updatedAt,
  };
}

/**
 * Forma del producto que recibe el flujo de generación de imágenes de n8n.
 *
 * Se deriva de `mapProducto` y se queda SOLO con lo que describe al producto.
 * El consumidor es un agente de IA: los ids de cada fila de lista, los
 * contadores de tráfico y el estado comercial no ayudan a entender qué ES el
 * producto, le cuestan tokens en cada ejecución y encima los ids le sugieren
 * que esos números significan algo.
 *
 * Las cinco listas se aplanan a arrays de strings para que entren directo en un
 * prompt con un `join`, sin mapear `.texto` del otro lado. `categoria` se emite
 * como nombre por el mismo motivo.
 *
 * `sku` es lo único no descriptivo que se conserva: nombra la carpeta y los
 * archivos generados del lado de n8n. `id` se omite por redundante con él.
 *
 * ⚠️ A diferencia de `mapProducto`, este mapper NO se actualiza solo: un campo
 * de contenido nuevo en `Product` hay que sumarlo acá a mano o no llega a n8n.
 * Es el precio deliberado de un payload sin ruido — ver la spec
 * `docs/superpowers/specs/2026-08-26-webhook-generacion-imagenes-n8n-design.md`, §4.3.
 */
export function mapProductoParaN8n(producto) {
  const completo = mapProducto(producto);
  const soloTexto = (items) => items.map((item) => item.texto);

  return {
    sku: completo.sku,
    nombre: completo.nombre,
    descripcion: completo.descripcion,
    categoria: completo.categoria?.nombre ?? null,
    etiqueta: completo.etiqueta,
    fraseComercial: completo.fraseComercial,
    porQueLoVasAQuerer: completo.porQueLoVasAQuerer,
    tePasaEsto: completo.tePasaEsto,
    caracteristicas: soloTexto(completo.caracteristicas),
    beneficios: soloTexto(completo.beneficios),
    usos: soloTexto(completo.usos),
    idealPara: soloTexto(completo.idealPara),
    incluye: soloTexto(completo.incluye),
    especificaciones: completo.especificaciones.map((e) => ({ nombre: e.nombre, valor: e.valor })),
  };
}
