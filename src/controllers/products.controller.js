import { prisma } from "../lib/prisma.js";
import { esRequestDeAdmin } from "../middlewares/auth.middleware.js";
import * as googleDrive from "../services/googleDrive.service.js";
import * as cloudinary from "../services/cloudinary.service.js";
import { generarSku } from "../lib/sku.js";
import { logAudit } from "../lib/logAudit.js";
import { calcularPrecio } from "../lib/precios.js";
import { logEvento, headersDeEvento } from "../lib/logEvento.js";
import { httpError } from "../lib/httpError.js";
import { parsearPaginacion } from "../lib/paginacion.js";
import {
  LIST_SELECT,
  PRODUCT_INCLUDE,
  mapProducto,
  mapProductoListado,
  mapProductoParaN8n,
} from "./products.mapper.js";
import { enviarPedidoDeImagenes, estaConfigurado as n8nEstaConfigurado } from "../services/n8n.service.js";
import {
  parseCaracteristicas,
  parseEspecificaciones,
  parseFotosExistentes,
  parseListas,
  parsearOrdenFotos,
  validarArchivos,
  validarCamposBase,
  validarCamposMerchandising,
  validarCostoYCoeficiente,
  validarOrdenFotos,
} from "./products.input.js";
import {
  limpiarArchivosSubidos,
  limpiarMediaRemota,
  logFallaDeLimpieza,
  sanitizarNombreParaCarpeta,
  subirArchivosNuevos,
} from "../services/productoMedia.service.js";

/**
 * Builds the `where` clause for `listar()` from optional query-string
 * filters (categoria, search, minPrecio/maxPrecio).
 *
 * Malformed values are never a 400/500 on this browse endpoint — a bad
 * `?minPrecio=abc` from a stale link or a fumbled UI control just silently
 * drops that one filter instead of failing the whole listing. Each filter is
 * validated independently before being added.
 *
 * `visibleEnCatalogo: true` (when not in admin mode) is inserted FIRST so it
 * stays the leading key of the `where` object — there's a SQL Server index
 * on `[visibleEnCatalogo, orden]` and this keeps queries aligned with it.
 *
 * `stock: { gt: 0 }` (also only outside admin mode): a product that reached
 * zero stock stops appearing in the public LISTING, so it doesn't take up a
 * slot in the grid. Its detail page stays reachable though (see
 * `obtenerPorId`), showing an "Agotado" badge with the buy CTA disabled — a
 * shared link to an out-of-stock product must not 404. The admin listing
 * still needs to see it (to restock or edit it), so this exclusion is
 * public-only, same as `visibleEnCatalogo`.
 */
/**
 * Productos por página del catálogo, distinto del `DEFAULT_PAGE_SIZE` de los
 * listados del admin.
 *
 * 12 porque es el número que le cierra a la grilla: es múltiplo de 1, 2 y 4
 * (las columnas que `/coleccion` usa en mobile, `md` y `lg`), así que ninguna
 * página termina con una fila huérfana. Además deja la respuesta en una docena
 * de fichas livianas, que es más o menos un scroll de pantalla. (La vieja
 * justificación de la "card ancha cada cuatro" ya no aplica: esa variante
 * horizontal se eliminó y la grilla es de 4 columnas uniformes en `lg`.)
 */
export const PAGE_SIZE_CATALOGO = 12;

/**
 * Ordenamientos permitidos del listado.
 *
 * El DEFAULT es `recientes`. Hasta el 29/08/2026 era `merchandising`, un
 * `orden` manual por producto que el admin editaba en el listado; se eliminó
 * entero por pedido explícito ("no se usa y no lo voy a usar"). El cambio no
 * alteró lo que se ve: los 80 productos de producción tenían todos `orden: 0`,
 * así que el criterio efectivo ya era el desempate — los más nuevos primero,
 * que es exactamente `recientes`.
 *
 * `vistas` existe para la
 * pantalla de métricas, que necesita "lo más visto primero" a lo largo de TODO
 * el catálogo — ordenar del lado del cliente solo reordenaría la página que
 * tocó, que es una respuesta directamente equivocada. El desempate por `id`
 * mantiene la paginación estable cuando varios productos comparten conteo.
 *
 * Un valor desconocido cae al default en vez de tirar 400, mismo criterio que
 * el resto de los filtros de este endpoint público.
 */
const ORDENES_LISTADO = {
  vistas: [{ vistas: "desc" }, { id: "asc" }],
  nombre: [{ nombre: "asc" }, { id: "asc" }],
  "nombre-desc": [{ nombre: "desc" }, { id: "asc" }],
  "precio-asc": [{ precio: "asc" }, { id: "asc" }],
  "precio-desc": [{ precio: "desc" }, { id: "asc" }],
  "stock-asc": [{ stock: "asc" }, { id: "asc" }],
  "stock-desc": [{ stock: "desc" }, { id: "asc" }],
  // `fotos._count` y no una columna: la cantidad de fotos es una relación, no
  // un campo del producto. Ordena en la base (el connector mssql lo soporta,
  // verificado contra SQL Server 2022), así que "sin fotos primero" recorre el
  // catálogo entero y no la página que se está viendo.
  "fotos-asc": [{ fotos: { _count: "asc" } }, { id: "asc" }],
  "fotos-desc": [{ fotos: { _count: "desc" } }, { id: "asc" }],
  // Desempate por `id` DESCENDENTE: dentro del mismo instante de creación, el
  // id más alto es el más nuevo. Con `asc` la fila más reciente de un lote
  // cargado de una sola vez quedaría última dentro de su propio grupo.
  recientes: [{ createdAt: "desc" }, { id: "desc" }],
};

function elegirOrden(valor) {
  return ORDENES_LISTADO[valor] ?? ORDENES_LISTADO.recientes;
}

/**
 * Tope de ids aceptados en `?ids=`. Existe para que nadie pueda pedir miles de
 * productos en una sola request: el `IN (...)` resultante va literal al SQL, y
 * una lista sin límite es un DoS gratis contra la base.
 *
 * Coincide con `MAX_PAGE_SIZE` a propósito — es el mismo techo de "cuántas
 * filas de producto puede devolver una request", pedidas por página o por id.
 */
export const MAX_IDS_LISTADO = 100;

/**
 * Parsea `?ids=1,7,12` a una lista de enteros positivos.
 *
 * Devuelve `null` cuando el parámetro no viene (el listado normal), y un array
 * — posiblemente vacío — cuando sí viene. Esa distinción es la parte
 * importante: `?ids=` (vacío) o `?ids=abc` significan "ninguno de estos
 * productos", NO "todo el catálogo". Devolver el catálogo entero ante una
 * lista vacía sería exactamente el bug que este parámetro viene a evitar en
 * carrito/checkout/favoritos.
 *
 * Los valores basura (no numéricos, negativos, fraccionarios) se descartan en
 * silencio, igual que el resto de los filtros de este endpoint público. Pero
 * pasarse del tope NO se trunca en silencio: truncar una lista de carrito
 * borraría líneas sin avisar, así que se responde 400 y el cliente pagina la
 * lista en tandas.
 */
export function parsearIdsListado(valor) {
  if (valor === undefined) return null;
  if (typeof valor !== "string") return [];

  const crudos = valor.split(",");
  if (crudos.length > MAX_IDS_LISTADO) {
    throw httpError(400, `No se pueden pedir más de ${MAX_IDS_LISTADO} productos por id en una sola consulta.`);
  }

  const ids = [];
  const vistos = new Set();
  for (const crudo of crudos) {
    const id = Number(crudo.trim());
    if (!Number.isInteger(id) || id <= 0 || vistos.has(id)) continue;
    vistos.add(id);
    ids.push(id);
  }
  return ids;
}

function construirFiltrosListado(query, { esAdmin, ids }) {
  const where = {};
  if (!esAdmin) {
    where.visibleEnCatalogo = true;
    where.stock = { gt: 0 };
  }

  // `ids` se compone con el resto del `where`, no lo reemplaza: las guardas
  // públicas de visibilidad y stock tienen que seguir aplicando. Es lo que
  // mantiene intacta la semántica en la que ya se apoyan carrito, checkout y
  // favoritos — "no vino en la respuesta" siempre quiso decir "no se puede
  // comprar", y pedir por id no cambia eso.
  if (ids !== null) where.id = { in: ids };

  if (query.categoria !== undefined) {
    // `Number.isInteger`, no `!Number.isNaN`: `categoriaId` es Int en el
    // schema, y un float ("1.5") pasaba el chequeo de NaN y reventaba en
    // Prisma con un 500 — en el endpoint público de browse.
    const categoriaId = Number(query.categoria);
    if (Number.isInteger(categoriaId)) where.categoriaId = categoriaId;
  }

  // `destacado=1` alimenta el bento de la home y de `/coleccion`: son cuatro
  // productos concretos, no los primeros de la página actual. Sin este filtro
  // el bento tendría que bajarse el catálogo entero para encontrarlos — y con
  // el listado paginado ni siquiera eso alcanzaría, porque un destacado puede
  // caer en cualquier página.
  if (query.destacado !== undefined) where.destacado = true;

  if (typeof query.search === "string" && query.search.trim() !== "") {
    const termino = query.search.trim();

    // No `mode: "insensitive"` here on purpose: this database's default
    // collation is SQL_Latin1_General_CP1_CI_AS (case-insensitive already,
    // confirmed live against the dev SQL Server), and the mssql Prisma
    // connector doesn't support the `mode` option at all — passing it
    // throws "Unknown argument mode" at runtime. Plain `contains` is both
    // correct and the only option here.
    //
    // The term matches against nombre, SKU, and categoria name. It used to
    // check `nombre` alone, which made the admin list unsearchable by the
    // very SKU its own table displays — the admin knows a product by its
    // code as often as by its name.
    //
    // `OR` (not a single field) means the caller doesn't have to declare
    // WHICH field they're typing into: one box, and whatever they know about
    // the product finds it. The public catalog gets the same widening, which
    // is a feature there too — a shopper pasting a SKU from a shared link
    // lands on the product instead of an empty grid.
    where.OR = [
      { nombre: { contains: termino } },
      { sku: { contains: termino } },
      { categoria: { nombre: { contains: termino } } },
    ];
  }

  // `Number.isFinite`, no `!Number.isNaN`: `"1e400"` da `Infinity`, que no es
  // NaN pero revienta contra el `Decimal` de Prisma con un 500. Un precio
  // fraccionario ("99.99") sigue siendo un filtro válido.
  const rangoPrecio = {};
  if (query.minPrecio !== undefined) {
    const min = Number(query.minPrecio);
    if (Number.isFinite(min)) rangoPrecio.gte = min;
  }
  if (query.maxPrecio !== undefined) {
    const max = Number(query.maxPrecio);
    if (Number.isFinite(max)) rangoPrecio.lte = max;
  }
  if (Object.keys(rangoPrecio).length > 0) where.precio = rangoPrecio;

  return Object.keys(where).length > 0 ? where : undefined;
}

export async function listar(req, res, next) {
  try {
    const esAdmin = esRequestDeAdmin(req);
    const ids = parsearIdsListado(req.query.ids);

    // Cortocircuito: se pidieron ids y ninguno quedó en pie. No hay nada que
    // consultar, y una consulta con `id: { in: [] }` sería un viaje perdido.
    if (ids !== null && ids.length === 0) {
      res.json({ data: [], page: 1, pageSize: MAX_IDS_LISTADO, total: 0 });
      return;
    }

    const where = construirFiltrosListado(req.query, { esAdmin, ids });
    const orderBy = elegirOrden(req.query.orden);

    // Pedir por `ids` saltea la paginación a propósito: el llamador ya enumeró
    // exactamente qué quiere y la lista ya viene acotada por `MAX_IDS_LISTADO`,
    // así que el resultado está tan limitado como una página. Recortarlo otra
    // vez le devolvería al carrito menos líneas de las que pidió, que es
    // justamente el bug que `ids` viene a evitar. Tampoco se cuenta: el total
    // es lo que se devuelve.
    if (ids !== null) {
      const productos = await prisma.product.findMany({ where, select: LIST_SELECT, orderBy });
      const data = productos.map((producto) => mapProductoListado(producto, { esAdmin }));
      res.json({ data, page: 1, pageSize: MAX_IDS_LISTADO, total: data.length });
      return;
    }

    const { page, pageSize } = parsearPaginacion(req.query, { porDefecto: PAGE_SIZE_CATALOGO });

    const [total, productos] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        select: LIST_SELECT,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      data: productos.map((producto) => mapProductoListado(producto, { esAdmin })),
      page,
      pageSize,
      total,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /resumen — conteos de catálogo para el encabezado del listado del admin.
 *
 * Son conteos GLOBALES: no los toca el `?search=` ni la página que el admin
 * esté mirando. La pregunta que contestan es "cuánto catálogo tengo", no
 * "cuánto entró en esta tabla" — esa segunda ya la contesta el `total` del
 * listado paginado.
 *
 * **`visibles` y `publicados` son dos números distintos a propósito.**
 * `visibleEnCatalogo: true` es el toggle "Catálogo" de la tabla, y es lo que
 * el admin cruza contra estos números. Pero el listado público además excluye
 * los agotados (ver `construirFiltrosListado`), así que un producto visible sin
 * stock NO se ve en `/coleccion`. Publicar un solo número obligaría a elegir
 * entre coincidir con el toggle o coincidir con la tienda, y cualquiera de las
 * dos lecturas engaña la mitad de las veces. Se emiten los dos y la pantalla
 * muestra la diferencia.
 *
 * `destacadosPublicados` sigue el mismo criterio y contesta la pregunta que
 * hace un admin cuando el carrusel "Hallazgos del día" no aparece: la home lo
 * esconde por debajo de cuatro destacados **visibles y con stock**, no cuatro
 * con el flag encendido.
 *
 * Requiere auth: `total` y `visibles` incluyen los productos ocultos, que es
 * justamente lo que la vista pública no puede ver.
 */
export async function resumen(req, res, next) {
  try {
    const publicado = { visibleEnCatalogo: true, stock: { gt: 0 } };

    const [total, visibles, publicados, destacados, destacadosPublicados] = await Promise.all([
      prisma.product.count(),
      prisma.product.count({ where: { visibleEnCatalogo: true } }),
      prisma.product.count({ where: publicado }),
      prisma.product.count({ where: { destacado: true } }),
      prisma.product.count({ where: { destacado: true, ...publicado } }),
    ]);

    res.json({ total, visibles, publicados, destacados, destacadosPublicados });
  } catch (err) {
    next(err);
  }
}

/**
 * Fetches up to 4 related products for the detail page: same categoriaId OR
 * same etiqueta as the current product (either match counts, not both),
 * excluding the product itself. Short-circuits to `[]` without a DB
 * round-trip when the product has neither field set — that's a normal case
 * (nothing to match on), not an error.
 *
 * Only one level deep: related rows are mapped with `mapProductoListado` and
 * never get their own `relacionados` computed, avoiding recursion.
 *
 * Usa el mismo payload liviano que el listado (`LIST_SELECT`): estas cuatro
 * filas se renderizan con `ProductCard`, igual que la grilla de `/coleccion`,
 * así que traer su contenido comercial completo era peso muerto en CADA
 * apertura de ficha.
 */
async function obtenerRelacionados(producto, { esAdmin }) {
  const { categoriaId, etiqueta } = producto;
  if (!categoriaId && !etiqueta) return [];

  const or = [];
  if (categoriaId) or.push({ categoriaId });
  if (etiqueta) or.push({ etiqueta });

  const where = {
    id: { not: producto.id },
    OR: or,
    ...(esAdmin ? {} : { visibleEnCatalogo: true, stock: { gt: 0 } }),
  };

  const relacionados = await prisma.product.findMany({
    where,
    select: LIST_SELECT,
    take: 4,
  });

  // Sin `esAdmin`: los relacionados alimentan `ProductCard` en la ficha
  // pública. Un admin abriendo esa ficha tampoco necesita el costo de los
  // productos vecinos, y no emitirlo mantiene la superficie chica.
  return relacionados.map((producto) => mapProductoListado(producto));
}

export async function obtenerPorId(req, res, next) {
  try {
    const id = Number(req.params.id);
    // `Number.isInteger`, no `Number.isNaN` (acá y en el resto de la familia
    // `/:id`): un float ("1.5") no es NaN y llegaría a Prisma como filtro
    // sobre una columna Int → `PrismaClientValidationError` → 500 en un
    // endpoint público, en vez del mismo 404 que un id inexistente.
    if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");

    const existe = await prisma.product.findUnique({ where: { id } });
    if (!existe) throw httpError(404, "Producto no encontrado.");

    // La precarga del form de edición del admin también pega acá, pero no es
    // la visita de un visitante: con un token válido no se incrementa `vistas`
    // ni se emite `VISTA_PRODUCTO`, así que un admin editando un producto no
    // infla su propio contador.
    //
    // Esa supresión también pasó a depender del token, no de `?admin=1`: si
    // dependiera del parámetro, cualquiera podría no ser contado (y evitar el
    // evento de tráfico) con solo agregarlo a la URL. La visita de un anónimo
    // que escribe `?admin=1` es una visita real y se cuenta como tal.
    const esAdmin = esRequestDeAdmin(req);

    // Un producto agotado (`stock <= 0`) SÍ es visible en su ficha de detalle:
    // el visitante ve que existe, con el badge "Agotado" y sin poder comprarlo.
    // Solo se lo excluye del listado público (ver `construirFiltrosListado`),
    // así no ocupa lugar en la grilla pero su link compartido sigue abriendo.
    // `visibleEnCatalogo: false` sí sigue siendo 404: eso es el admin ocultando
    // el producto a propósito, distinto de quedarse sin stock. Solo un token
    // verificado levanta este 404 — es la guarda que `?admin=1` derrotaba.
    if (!esAdmin && !existe.visibleEnCatalogo) {
      throw httpError(404, "Producto no encontrado.");
    }

    let producto;
    if (esAdmin) {
      producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    } else {
      producto = await prisma.product.update({
        where: { id },
        data: { vistas: { increment: 1 } },
        include: PRODUCT_INCLUDE,
      });
      // El evento es ADITIVO al contador `vistas`, no lo reemplaza: el contador
      // da el total acumulado, el evento agrega el cuándo y el de-dónde para el
      // análisis de tráfico. Va acá adentro a propósito, atado a la misma
      // condición `!esAdmin` que el incremento — un admin abriendo el form de
      // edición no genera una vista. Fire-and-forget: la respuesta no espera.
      logEvento({ tipo: "VISTA_PRODUCTO", productId: id, ...headersDeEvento(req) });
    }

    const relacionados = await obtenerRelacionados(producto, { esAdmin });

    res.json({ ...mapProducto(producto, { esAdmin }), relacionados });
  } catch (err) {
    next(err);
  }
}

export async function compartir(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");

    const existe = await prisma.product.findUnique({ where: { id } });
    if (!existe) throw httpError(404, "Producto no encontrado.");

    // Misma paridad de 404 que `obtenerPorId` y los proxies de media: para un
    // anónimo, un producto oculto y un id inexistente tienen que ser
    // indistinguibles (mismo status Y mismo cuerpo) — los ids son secuenciales
    // y sin esta guarda el `{ ok: true }` permitía enumerar los ocultos,
    // además de inflarles el contador. `stock <= 0` NO entra acá a propósito:
    // la ficha de un agotado devuelve 200 para que un link compartido no se
    // rompa, y compartirlo es parte de ese mismo contrato.
    if (!esRequestDeAdmin(req) && !existe.visibleEnCatalogo) {
      throw httpError(404, "Producto no encontrado.");
    }

    await prisma.product.update({ where: { id }, data: { compartidos: { increment: 1 } } });

    // Aditivo al contador `compartidos` (ver `obtenerPorId`), fire-and-forget.
    logEvento({ tipo: "COMPARTIDO", productId: id, ...headersDeEvento(req) });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function favorito(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");

    const existe = await prisma.product.findUnique({ where: { id } });
    if (!existe) throw httpError(404, "Producto no encontrado.");

    // Misma guarda y mismo razonamiento que `compartir` (ver arriba).
    if (!esRequestDeAdmin(req) && !existe.visibleEnCatalogo) {
      throw httpError(404, "Producto no encontrado.");
    }

    await prisma.product.update({ where: { id }, data: { favoritosCount: { increment: 1 } } });

    // Aditivo al contador `favoritosCount` (ver `obtenerPorId`), fire-and-forget.
    logEvento({ tipo: "FAVORITO_AGREGADO", productId: id, ...headersDeEvento(req) });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

export async function crear(req, res, next) {
  let subidas = null;
  let producto = null;
  try {
    const {
      nombre, descripcion, precio, etiqueta, categoriaId, stock, destacado,
      fraseComercial, porQueLoVasAQuerer, tePasaEsto, costo, coeficiente,
    } = req.body;
    validarCamposBase({ nombre, descripcion, precio }, { esCreacion: true });
    const merchandising = validarCamposMerchandising({ stock, destacado });
    const costeo = validarCostoYCoeficiente({ costo, coeficiente });

    const caracteristicas = parseCaracteristicas(req.body.caracteristicas) ?? [];
    const beneficios = parseListas(req.body.beneficios, "BENEFICIO") ?? [];
    const usos = parseListas(req.body.usos, "USO") ?? [];
    const idealPara = parseListas(req.body.idealPara, "IDEAL_PARA") ?? [];
    const incluye = parseListas(req.body.incluye, "INCLUYE") ?? [];
    const especificaciones = parseEspecificaciones(req.body.especificaciones) ?? [];
    const fotosNuevas = req.files?.fotos ?? [];
    const videoArr = req.files?.video ?? [];

    validarArchivos({ fotosNuevas, fotosExistentesCount: 0, video: videoArr });

    // Create the DB row first (no media yet) so we have a real id — this
    // ordering originally existed to name the product's Drive subfolder
    // (design item 1's ordering fix), and still serves the same purpose for
    // Cloudinary's per-product folder below. Also relied on for the
    // orphan-prevention behavior below (a media-less product row is an
    // accepted partial state on upload failure).
    //
    // sku is NOT NULL + unique, so it must be generated up front (it can't
    // depend on the id, which doesn't exist yet at this point). A handful of
    // retries absorbs the rare random-suffix collision (P2002 on sku)
    // instead of failing the whole request over it.
    const MAX_INTENTOS_SKU = 5;
    for (let intento = 1; intento <= MAX_INTENTOS_SKU; intento++) {
      try {
        producto = await prisma.product.create({
          data: {
            nombre: nombre.trim(),
            descripcion: descripcion.trim(),
            precio: String(precio),
            // El precio NO se deriva del costo acá: se escribe el que vino en
            // el formulario. Cambiar el costo nunca mueve el precio publicado
            // por su cuenta — eso lo hace la aplicación explícita del panel.
            costo: costeo.costo ?? null,
            coeficiente: costeo.coeficiente ?? null,
            etiqueta: etiqueta?.trim() || null,
            categoriaId: categoriaId ? Number(categoriaId) : null,
            sku: generarSku(nombre.trim()),
            stock: merchandising.stock ?? 0,
            destacado: merchandising.destacado ?? false,
            caracteristicas: { create: caracteristicas },
            fraseComercial: fraseComercial?.trim() || null,
            porQueLoVasAQuerer: porQueLoVasAQuerer?.trim() || null,
            tePasaEsto: tePasaEsto?.trim() || null,
            listas: {
              create: [
                ...beneficios.map((item, index) => ({ ...item, orden: index })),
                ...usos.map((item, index) => ({ ...item, orden: index })),
                ...idealPara.map((item, index) => ({ ...item, orden: index })),
                ...incluye.map((item, index) => ({ ...item, orden: index })),
              ],
            },
            especificaciones: { create: especificaciones.map((e, index) => ({ ...e, orden: index })) },
          },
          include: PRODUCT_INCLUDE,
        });
        break;
      } catch (err) {
        const esColisionSku = err?.code === "P2002" && err.meta?.target?.includes?.("sku");
        if (!esColisionSku || intento === MAX_INTENTOS_SKU) throw err;
      }
    }

    // No hay un paso previo de "crear carpeta" como tenía Drive: Cloudinary
    // la crea implícitamente al recibir `folder` en la subida.
    //
    // Cloudinary organizes uploads by product, mirroring Drive's old
    // per-product subfolder — see cloudinary.service.js's subirArchivo doc.
    const folder = `productos/${producto.id}-${sanitizarNombreParaCarpeta(nombre.trim())}`;

    subidas = await subirArchivosNuevos({ fotosNuevas, videoNuevo: videoArr[0] ?? null, folder });
    const { fotosSubidas, videoSubido } = subidas;

    producto = await prisma.product.update({
      where: { id: producto.id },
      data: {
        fotos: {
          create: fotosSubidas.map((f, index) => ({
            url: f.url,
            cloudinaryPublicId: f.cloudinaryPublicId,
            cloudinaryResourceType: f.cloudinaryResourceType,
            orden: index,
          })),
        },
        video: videoSubido
          ? {
              create: {
                url: videoSubido.url,
                cloudinaryPublicId: videoSubido.cloudinaryPublicId,
                cloudinaryResourceType: videoSubido.cloudinaryResourceType,
              },
            }
          : undefined,
      },
      include: PRODUCT_INCLUDE,
    });

    // Fire-and-forget: la respuesta no espera el insert de auditoría.
    logAudit(req, {
      accion: "CREAR",
      entidad: "Producto",
      entidadId: producto.id,
      detalle: { nombre: producto.nombre, sku: producto.sku },
    });

    res.status(201).json(mapProducto(producto, { esAdmin: true }));
  } catch (err) {
    // Orphan prevention (design D6): clean up any Cloudinary uploads from
    // this batch. The product DB row (if created) is intentionally NOT rolled
    // back — per design item 1, a partially-created product (no media) is
    // an accepted state the admin can fix by editing.
    if (subidas) await limpiarArchivosSubidos({ fotos: subidas.fotosSubidas, video: subidas.videoSubido }, req);
    next(err);
  }
}

export async function actualizar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");

    const existente = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const {
      nombre, descripcion, precio, etiqueta, categoriaId, stock, destacado,
      fraseComercial, porQueLoVasAQuerer, tePasaEsto, costo, coeficiente,
    } = req.body;
    validarCamposBase({ nombre, descripcion, precio }, { esCreacion: false });
    const merchandising = validarCamposMerchandising({ stock, destacado });
    const costeo = validarCostoYCoeficiente({ costo, coeficiente });

    const caracteristicas = parseCaracteristicas(req.body.caracteristicas);
    const beneficios = parseListas(req.body.beneficios, "BENEFICIO");
    const usos = parseListas(req.body.usos, "USO");
    const idealPara = parseListas(req.body.idealPara, "IDEAL_PARA");
    const incluye = parseListas(req.body.incluye, "INCLUYE");
    const especificaciones = parseEspecificaciones(req.body.especificaciones);
    const fotosExistentesIds = parseFotosExistentes(req.body.fotosExistentes) ?? existente.fotos.map((f) => f.id);
    const fotosNuevas = req.files?.fotos ?? [];
    const videoArr = req.files?.video ?? [];
    const eliminarVideo = req.body.eliminarVideo === "true";

    validarArchivos({ fotosNuevas, fotosExistentesCount: fotosExistentesIds.length, video: videoArr });

    // Photos removed by the client (present before, absent from fotosExistentes) get deleted from Drive too.
    const fotosARemover = existente.fotos.filter((f) => !fotosExistentesIds.includes(f.id));

    // Se valida ANTES de subir nada a Cloudinary: si la secuencia es
    // inconsistente conviene fallar con 400 sin haber dejado archivos huérfanos.
    const ordenFotos = parsearOrdenFotos(req.body.ordenFotos);
    validarOrdenFotos(ordenFotos, {
      idsConservados: existente.fotos.filter((f) => fotosExistentesIds.includes(f.id)).map((f) => f.id),
      cantidadNuevas: fotosNuevas.length,
    });

    // Toda subida nueva, sobre CUALQUIER producto (nuevo o legado con media
    // en Drive), va a Cloudinary, agrupada en la carpeta propia del producto
    // — misma idea de agrupación por producto que la subcarpeta de Drive,
    // otro storage. Las fotos que un producto legado YA tiene en Drive quedan
    // intactas: esto solo decide dónde aterriza una subida NUEVA.
    const folder = `productos/${existente.id}-${sanitizarNombreParaCarpeta((nombre ?? existente.nombre).trim())}`;

    const subidas = await subirArchivosNuevos({
      fotosNuevas,
      videoNuevo: videoArr[0] ?? null,
      folder,
    });
    const { fotosSubidas, videoSubido } = subidas;

    let productoActualizado;
    try {
      productoActualizado = await prisma.$transaction(async (tx) => {
        // Text fields
        await tx.product.update({
          where: { id },
          data: {
            nombre: nombre !== undefined ? nombre.trim() : undefined,
            descripcion: descripcion !== undefined ? descripcion.trim() : undefined,
            precio: precio !== undefined ? String(precio) : undefined,
            // `undefined` deja la columna como está, `null` la borra. Es la
            // semántica que devuelve `validarCostoYCoeficiente` y la que hace
            // que un campo vaciado en el formulario efectivamente saque el dato.
            costo: costeo.costo,
            coeficiente: costeo.coeficiente,
            etiqueta: etiqueta !== undefined ? etiqueta?.trim() || null : undefined,
            categoriaId: categoriaId !== undefined ? (categoriaId ? Number(categoriaId) : null) : undefined,
            stock: merchandising.stock,
            destacado: merchandising.destacado,
            fraseComercial: fraseComercial !== undefined ? fraseComercial?.trim() || null : undefined,
            porQueLoVasAQuerer: porQueLoVasAQuerer !== undefined ? porQueLoVasAQuerer?.trim() || null : undefined,
            tePasaEsto: tePasaEsto !== undefined ? tePasaEsto?.trim() || null : undefined,
          },
        });

        // Caracteristicas: full replace when provided
        if (caracteristicas !== undefined) {
          await tx.caracteristica.deleteMany({ where: { productId: id } });
          if (caracteristicas.length > 0) {
            await tx.caracteristica.createMany({
              data: caracteristicas.map((c) => ({ ...c, productId: id })),
            });
          }
        }

        // Listas comerciales: full replace per-tipo, only when provided
        for (const [tipo, items] of [
          ["BENEFICIO", beneficios],
          ["USO", usos],
          ["IDEAL_PARA", idealPara],
          ["INCLUYE", incluye],
        ]) {
          if (items === undefined) continue;
          await tx.productoLista.deleteMany({ where: { productId: id, tipo } });
          if (items.length > 0) {
            await tx.productoLista.createMany({
              data: items.map((item, index) => ({ ...item, orden: index, productId: id })),
            });
          }
        }

        // Especificaciones: full replace when provided
        if (especificaciones !== undefined) {
          await tx.especificacion.deleteMany({ where: { productId: id } });
          if (especificaciones.length > 0) {
            await tx.especificacion.createMany({
              data: especificaciones.map((e, index) => ({ ...e, orden: index, productId: id })),
            });
          }
        }

        // Fotos: remove any not in fotosExistentesIds, keep the rest, append new ones, re-normalize orden
        if (fotosARemover.length > 0) {
          await tx.foto.deleteMany({ where: { id: { in: fotosARemover.map((f) => f.id) } } });
        }
        const fotosConservadas = existente.fotos.filter((f) => fotosExistentesIds.includes(f.id));

        if (ordenFotos) {
          // Secuencia explícita: la posición en el array ES el `orden` final,
          // así una foto recién subida puede quedar de portada por delante de
          // las que ya estaban.
          const nuevasPorIndice = fotosSubidas;
          const aCrear = [];

          for (const [posicion, token] of ordenFotos.entries()) {
            if (token.tipo === "existente") {
              await tx.foto.update({ where: { id: token.id }, data: { orden: posicion } });
            } else {
              const subida = nuevasPorIndice[token.index];
              aCrear.push({
                url: subida.url,
                cloudinaryPublicId: subida.cloudinaryPublicId,
                cloudinaryResourceType: subida.cloudinaryResourceType,
                orden: posicion,
                productId: id,
              });
            }
          }

          if (aCrear.length > 0) {
            await tx.foto.createMany({ data: aCrear });
          }
        } else {
          // Sin secuencia explícita: comportamiento histórico — se conserva el
          // orden que ya tenían y las nuevas van al final.
          const ordenBase = fotosConservadas.length;
          for (const [index, foto] of fotosConservadas.entries()) {
            await tx.foto.update({ where: { id: foto.id }, data: { orden: index } });
          }
          if (fotosSubidas.length > 0) {
            await tx.foto.createMany({
              data: fotosSubidas.map((f, index) => ({
                url: f.url,
                cloudinaryPublicId: f.cloudinaryPublicId,
                cloudinaryResourceType: f.cloudinaryResourceType,
                orden: ordenBase + index,
                productId: id,
              })),
            });
          }
        }

        // Video: replace, remove, or leave unchanged
        if (videoSubido) {
          if (existente.video) {
            await tx.video.update({
              where: { productId: id },
              data: {
                url: videoSubido.url,
                cloudinaryPublicId: videoSubido.cloudinaryPublicId,
                cloudinaryResourceType: videoSubido.cloudinaryResourceType,
              },
            });
          } else {
            await tx.video.create({
              data: {
                url: videoSubido.url,
                cloudinaryPublicId: videoSubido.cloudinaryPublicId,
                cloudinaryResourceType: videoSubido.cloudinaryResourceType,
                productId: id,
              },
            });
          }
        } else if (eliminarVideo && existente.video) {
          await tx.video.delete({ where: { productId: id } });
        }

        return tx.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
      });
    } catch (dbErr) {
      // Orphan prevention (design D6): DB write failed after successful Cloudinary upload(s).
      await limpiarArchivosSubidos({ fotos: fotosSubidas, video: videoSubido }, req);
      throw dbErr;
    }

    // DB writes succeeded — now clean up whichever storage backend each
    // removed photo/video actually used. Van todas en paralelo: son hasta 11
    // round trips independientes contra Cloudinary/Drive y el cliente está
    // esperando la respuesta detrás de ellos. Ninguna puede rechazar
    // (`limpiarMediaRemota` traga y registra), así que el `allSettled` solo
    // cubre un throw imprevisto del SDK.
    const limpiezas = fotosARemover.map((foto) => limpiarMediaRemota(foto, "la foto", req));
    if (videoSubido && existente.video) {
      limpiezas.push(limpiarMediaRemota(existente.video, "el video anterior", req));
    } else if (eliminarVideo && existente.video) {
      limpiezas.push(limpiarMediaRemota(existente.video, "el video", req));
    }
    await Promise.allSettled(limpiezas);

    logAudit(req, {
      accion: "ACTUALIZAR",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        nombreAnterior: existente.nombre,
        nombreNuevo: productoActualizado.nombre,
        precioAnterior: String(existente.precio),
        precioNuevo: String(productoActualizado.precio),
        stockAnterior: existente.stock,
        stockNuevo: productoActualizado.stock,
      },
    });

    res.json(mapProducto(productoActualizado, { esAdmin: true }));
  } catch (err) {
    next(err);
  }
}

export async function actualizarVisibilidad(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");

    const { visibleEnCatalogo } = req.body;
    if (typeof visibleEnCatalogo !== "boolean") {
      throw httpError(400, "visibleEnCatalogo debe ser true o false.");
    }

    const existente = await prisma.product.findUnique({ where: { id } });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.update({
      where: { id },
      data: { visibleEnCatalogo },
      include: PRODUCT_INCLUDE,
    });

    logAudit(req, {
      accion: "ACTUALIZAR_VISIBILIDAD",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        visibleAnterior: existente.visibleEnCatalogo,
        visibleNuevo: producto.visibleEnCatalogo,
      },
    });

    res.json(mapProducto(producto, { esAdmin: true }));
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /:id/merchandising — el toggle "Destacado" del listado del admin,
 * espejando la forma de `actualizarVisibilidad`.
 *
 * La ruta conserva el nombre `merchandising` aunque hoy maneje un solo campo:
 * hasta el 29/08/2026 escribía también un `orden` manual, que se eliminó por
 * no usarse. Renombrarla sería un cambio de contrato (frontend, tests y el
 * `accion` de la auditoría, que es lo que se consulta en los logs históricos)
 * a cambio de nada.
 *
 * Accepts JSON, so `destacado` arrives as a
 * real boolean here (unlike crear()/actualizar()'s multipart/form-data,
 * where it arrives as a string) — `validarCamposMerchandising()` handles
 * both shapes via `coerceDestacado()`, so this endpoint reuses the same
 * validator as crear()/actualizar() instead of re-checking the rules here.
 */
export async function actualizarMerchandising(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");

    const { destacado } = req.body;

    if (destacado === undefined) {
      throw httpError(400, "Debe enviar destacado.");
    }
    const merchandising = validarCamposMerchandising({ destacado });

    const existente = await prisma.product.findUnique({ where: { id } });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.update({
      where: { id },
      data: { destacado: merchandising.destacado },
      include: PRODUCT_INCLUDE,
    });

    logAudit(req, {
      accion: "ACTUALIZAR_MERCHANDISING",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        destacadoAnterior: existente.destacado,
        destacadoNuevo: producto.destacado,
      },
    });

    res.json(mapProducto(producto, { esAdmin: true }));
  } catch (err) {
    next(err);
  }
}

export async function eliminar(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!producto) throw httpError(404, "Producto no encontrado.");

    // Sin pre-chequeo de ventas: `ItemOrden.productId` es nullable con
    // `onDelete: SetNull`, así que la base desliga las líneas históricas sola
    // y ya no hay P2003 que anticipar. Antes se contaba `ItemOrden` para
    // devolver un 400 explicativo, y eso volvía imborrable a cualquier
    // producto que apareciera en una orden — incluidas las CANCELADAS.
    await borrarFilaYLimpiarMedia(producto, req);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * Borra la fila del producto, la audita y barre su media remota.
 *
 * Extraído para que el borrado individual (`eliminar`) y el masivo
 * (`eliminarMasivo`) compartan exactamente el mismo orden de operaciones. Es
 * la parte sutil del borrado —el barrido de archivos antes que el de la
 * carpeta, la auditoría antes que la limpieza— y tenerla dos veces sería
 * tenerla mal en una de las dos en cuanto alguien toque una.
 *
 * NO valida el historial de ventas: cada llamador decide qué hacer con un
 * producto vendido (el individual tira 400, el masivo lo informa como
 * rechazado y sigue con el resto).
 */
async function borrarFilaYLimpiarMedia(producto, req) {
  // DB delete first (design D6/ordering): a dangling DB row is worse than an orphaned Drive file.
  await prisma.product.delete({ where: { id: producto.id } });

  // Se audita apenas la fila se borró, antes de la limpieza de media: el
  // borrado ya es irreversible en este punto, y la limpieza de Cloudinary/
  // Drive puede fallar sin invalidar el hecho de que el producto se eliminó.
  logAudit(req, {
    accion: "ELIMINAR",
    entidad: "Producto",
    entidadId: producto.id,
    detalle: { nombre: producto.nombre, sku: producto.sku },
  });

  {
    // Always sweep individual files first — a product may have a
    // driveFolderId AND still have some fotos/video whose driveFileId
    // predates that folder (e.g. a legacy product that was edited once
    // after this feature shipped: the new upload went into a fresh
    // subfolder, but its original photos are still in the flat root
    // folder). Deleting the folder alone would leave those orphaned.
    //
    // Los archivos se barren en paralelo (hasta 10 fotos + 1 video), pero el
    // borrado de las carpetas SIGUE SIENDO POSTERIOR y no se puede meter en
    // la misma tanda: `delete_folder` de la Admin API de Cloudinary solo
    // funciona sobre una carpeta vacía, así que adelantarlo la dejaría viva
    // para siempre.
    await Promise.allSettled([
      ...producto.fotos.map((foto) => limpiarMediaRemota(foto, "la foto", req)),
      ...(producto.video ? [limpiarMediaRemota(producto.video, "el video", req)] : []),
    ]);

    // Then remove the (now-empty, or never-used) per-product folders. The
    // Drive one only ever exists for legacy Drive-era products — Cloudinary
    // uploads never create one. La carpeta de Cloudinary usa la misma
    // fórmula de nombre que crear/actualizar, así coincide sin importar
    // cuándo se subió por última vez la media del producto.
    const carpetaCloudinary = `productos/${producto.id}-${sanitizarNombreParaCarpeta(producto.nombre.trim())}`;
    await Promise.allSettled([
      ...(producto.driveFolderId
        ? [
            googleDrive
              .eliminarArchivo(producto.driveFolderId)
              .catch((err) => logFallaDeLimpieza("No se pudo eliminar la carpeta del producto en Drive", err, req)),
          ]
        : []),
      cloudinary
        .eliminarCarpeta(carpetaCloudinary)
        .catch((err) => logFallaDeLimpieza("No se pudo eliminar la carpeta del producto en Cloudinary", err, req)),
    ]);
  }
}

/**
 * Valida la lista de ids de una acción masiva del admin.
 *
 * Comparte `MAX_IDS_LISTADO` con `?ids=` del listado a propósito: es el mismo
 * techo de "cuántas cosas puede nombrar un cliente en un pedido", y tenerlo
 * dos veces sería tenerlo distinto en cuanto alguien mueva uno.
 *
 * Una lista vacía es un 400, no un no-op silencioso: si la pantalla mandó un
 * lote vacío hay un bug en la selección, y devolver `{ actualizados: 0 }`
 * lo escondería detrás de un cartel de éxito.
 */
function parsearIdsMasivos(valor) {
  if (!Array.isArray(valor)) {
    throw httpError(400, "Se espera una lista de ids de producto.");
  }
  if (valor.length === 0) {
    throw httpError(400, "No se seleccionó ningún producto.");
  }
  if (valor.length > MAX_IDS_LISTADO) {
    throw httpError(400, `No se pueden procesar más de ${MAX_IDS_LISTADO} productos a la vez.`);
  }

  const ids = valor.map(Number);
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw httpError(400, "La lista contiene ids de producto inválidos.");
  }

  return [...new Set(ids)];
}

/**
 * Oculta o muestra varios productos de una sola vez, desde los checkbox del
 * listado del admin.
 *
 * Es un único `updateMany` porque no hay nada por producto que decidir: la
 * visibilidad no depende del estado anterior ni puede fallar parcialmente.
 * El borrado masivo, en cambio, sí es parcial por naturaleza — ver
 * `eliminarMasivo`.
 */
export async function actualizarVisibilidadMasiva(req, res, next) {
  try {
    const ids = parsearIdsMasivos(req.body?.ids);
    const { visible } = req.body ?? {};
    if (typeof visible !== "boolean") {
      throw httpError(400, "El campo 'visible' debe ser true o false.");
    }

    const { count } = await prisma.product.updateMany({
      where: { id: { in: ids } },
      data: { visibleEnCatalogo: visible },
    });

    // Un renglón de auditoría POR PRODUCTO, no uno por lote: la pregunta que
    // se le hace después a `AuditLog` es "¿quién ocultó ESTE producto?", y un
    // único registro con una lista adentro no la contesta sin parsear JSON.
    for (const id of ids) {
      logAudit(req, {
        accion: "ACTUALIZAR_VISIBILIDAD",
        entidad: "Producto",
        entidadId: id,
        detalle: { visibleEnCatalogo: visible, masivo: true },
      });
    }

    res.json({ actualizados: count });
  } catch (err) {
    next(err);
  }
}

/**
 * Elimina varios productos seleccionados en el listado del admin.
 *
 * **Este endpoint es parcial POR DISEÑO, y esa es su razón de existir.**
 * `ItemOrden.product` es `onDelete: NoAction`, así que un producto que
 * aparece en cualquier orden NO se puede borrar. En una selección grande eso
 * es lo habitual, no la excepción — por eso la respuesta separa `eliminados`
 * de `rechazados` con su motivo, y la pantalla lo muestra tal cual. Un
 * `{ ok: true }` después de borrar 38 de 50 le haría creer al admin que
 * limpió el catálogo cuando no.
 *
 * Se procesa SECUENCIALMENTE, no con `Promise.all`: cada borrado barre hasta
 * once archivos de Cloudinary más la carpeta del producto, y cien en paralelo
 * castigan a la vez a la base y a la API de Cloudinary. Es una acción de
 * admin, no una ruta caliente: la latencia importa mucho menos que no
 * derribar nada.
 */
export async function eliminarMasivo(req, res, next) {
  try {
    const ids = parsearIdsMasivos(req.body?.ids);

    const productos = await prisma.product.findMany({
      where: { id: { in: ids } },
      include: PRODUCT_INCLUDE,
    });
    const porId = new Map(productos.map((p) => [p.id, p]));

    const eliminados = [];
    const rechazados = [];

    // Se itera sobre `ids` y no sobre `productos` para que un id inexistente
    // aparezca como rechazado con su motivo, en vez de desaparecer del
    // informe: "pedí borrar 5 y me contestaron por 4" es peor que un error.
    for (const id of ids) {
      const producto = porId.get(id);
      if (!producto) {
        rechazados.push({ id, nombre: null, motivo: "El producto no existe." });
        continue;
      }

      // El historial de ventas ya no rechaza nada: `onDelete: SetNull` desliga
      // las líneas y la orden conserva sus snapshots. `rechazados` sobrevive
      // porque un id inexistente sigue siendo un caso real que hay que
      // informar en vez de tragarse.
      await borrarFilaYLimpiarMedia(producto, req);
      eliminados.push(id);
    }

    res.json({ eliminados, rechazados });
  } catch (err) {
    next(err);
  }
}

/**
 * Guarda el costo y el coeficiente de un producto desde la pantalla de precios,
 * al instante y sin pasar por el formulario completo.
 *
 * Es el tercer hermano de `actualizarVisibilidad` y `actualizarMerchandising`, y
 * existe por el mismo motivo: son campos que se editan desde una TABLA, donde
 * mandar un `PUT` multipart con el producto entero por dos números sería
 * absurdo y además pisaría lo que otra pestaña haya cambiado mientras tanto.
 *
 * **NO toca `precio`.** Guardar un costo nunca mueve el precio publicado: eso
 * lo hace `aplicarPreciosMasivo`, a pedido explícito. Es la invariante central
 * de la feature y el motivo de que estos dos endpoints estén separados.
 *
 * Acepta JSON. `null`/`""` borran la columna — ver `validarCostoYCoeficiente`.
 */
export async function actualizarCosteo(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");

    const { costo, coeficiente } = req.body ?? {};
    if (costo === undefined && coeficiente === undefined) {
      throw httpError(400, "Debe enviar costo o coeficiente.");
    }
    const costeo = validarCostoYCoeficiente({ costo, coeficiente });

    const existente = await prisma.product.findUnique({ where: { id } });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.update({
      where: { id },
      data: { costo: costeo.costo, coeficiente: costeo.coeficiente },
      include: PRODUCT_INCLUDE,
    });

    logAudit(req, {
      accion: "ACTUALIZAR_COSTEO",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        costoAnterior: existente.costo?.toString() ?? null,
        costoNuevo: producto.costo?.toString() ?? null,
        coeficienteAnterior: existente.coeficiente?.toString() ?? null,
        coeficienteNuevo: producto.coeficiente?.toString() ?? null,
      },
    });

    res.json(mapProducto(producto, { esAdmin: true }));
  } catch (err) {
    next(err);
  }
}

/**
 * Aplica el precio calculado (`costo × coeficiente`, redondeado a la centena
 * hacia arriba) a los productos seleccionados en la pantalla de precios.
 *
 * **Este endpoint es el único que escribe un precio derivado del costo, y esa
 * es toda la feature.** `precio` sigue siendo una columna propia: cambiar el
 * costo de un producto NO mueve su precio publicado hasta que alguien pase por
 * acá. Es lo que hace que el precio que ve el cliente sea siempre un número que
 * una persona aprobó, y lo que permite que el redondeo se muestre en pantalla
 * antes de escribirse en vez de ocurrir en silencio.
 *
 * `coeficiente` en el body es OPCIONAL y pisa el de cada producto — es el campo
 * "aplicar este coeficiente a los N seleccionados". Se guarda junto con el
 * precio: si solo se usara para la cuenta, el producto quedaría con un precio
 * que su propio coeficiente no explica, y la pantalla lo marcaría DIFIERE al
 * instante siguiente.
 *
 * **Validar primero, escribir después.** Los productos que no se pueden
 * precisar (sin costo, o inexistentes) se apartan ANTES de la transacción, con
 * su motivo. Así un producto sin costo no aborta el lote entero, y el informe
 * distingue "no se tocó" de "se tocó y no cambió" — un `{ ok: true }` después
 * de aplicar sobre 40 y haber escrito 31 sería una mentira.
 */
export async function aplicarPreciosMasivo(req, res, next) {
  try {
    const ids = parsearIdsMasivos(req.body?.ids);

    // El override se valida antes de leer la base: si viene mal, no tiene
    // sentido haber consultado nada.
    const { coeficiente: coeficienteOverride } = validarCostoYCoeficiente({
      coeficiente: req.body?.coeficiente,
    });

    const productos = await prisma.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, nombre: true, precio: true, costo: true, coeficiente: true },
    });
    const porId = new Map(productos.map((p) => [p.id, p]));

    const resultados = [];
    const rechazados = [];
    const aEscribir = [];

    // Se itera sobre `ids` y no sobre `productos` para que un id inexistente
    // aparezca en el informe con su motivo, mismo criterio que `eliminarMasivo`.
    for (const id of ids) {
      const producto = porId.get(id);
      if (!producto) {
        rechazados.push({ id, nombre: null, motivo: "El producto no existe." });
        continue;
      }

      const coeficienteEfectivo = coeficienteOverride ?? producto.coeficiente;
      const precioNuevo = calcularPrecio(producto.costo, coeficienteEfectivo);
      if (precioNuevo === null) {
        rechazados.push({
          id,
          nombre: producto.nombre,
          motivo: "No tiene costo y coeficiente cargados.",
        });
        continue;
      }

      const precioAnterior = producto.precio.toString();
      const cambiaPrecio = !producto.precio.equals(precioNuevo);
      const cambiaCoeficiente =
        coeficienteOverride !== undefined &&
        coeficienteOverride !== null &&
        !producto.coeficiente?.equals(coeficienteOverride);

      resultados.push({
        id,
        nombre: producto.nombre,
        precioAnterior,
        precioNuevo: precioNuevo.toString(),
        cambio: cambiaPrecio,
      });

      // Un producto ya al día no se reescribe: sin esto, cada aplicación
      // masiva llenaría `AuditLog` de cambios que no cambiaron nada y
      // esconderían los reales.
      if (cambiaPrecio || cambiaCoeficiente) {
        aEscribir.push({
          id,
          precioAnterior,
          data: {
            precio: precioNuevo.toString(),
            ...(cambiaCoeficiente && { coeficiente: coeficienteOverride }),
          },
        });
      }
    }

    // Todo o nada sobre lo que SÍ se puede escribir. Lo rechazado ya quedó
    // afuera, así que la transacción no puede abortar por un dato faltante.
    if (aEscribir.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const { id, data } of aEscribir) {
          await tx.product.update({ where: { id }, data });
        }
      });
    }

    // Un renglón por producto, no uno por lote: mismo criterio que
    // `actualizarVisibilidadMasiva`.
    for (const { id, precioAnterior, data } of aEscribir) {
      logAudit(req, {
        accion: "APLICAR_PRECIO",
        entidad: "Producto",
        entidadId: id,
        detalle: {
          precioAnterior,
          precioNuevo: data.precio,
          ...(data.coeficiente !== undefined && { coeficiente: data.coeficiente }),
          masivo: true,
        },
      });
    }

    res.json({ actualizados: aEscribir.length, resultados, rechazados });
  } catch (err) {
    next(err);
  }
}

export async function eliminarFoto(req, res, next) {
  try {
    const id = Number(req.params.id);
    const fotoId = Number(req.params.fotoId);
    if (!Number.isInteger(id) || !Number.isInteger(fotoId)) throw httpError(404, "Producto o foto no encontrados.");

    const producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!producto) throw httpError(404, "Producto no encontrado.");

    const foto = producto.fotos.find((f) => f.id === fotoId);
    if (!foto) throw httpError(404, "Foto no encontrada.");

    // DB delete first, then Drive cleanup (same ordering rationale as product delete).
    await prisma.$transaction(async (tx) => {
      await tx.foto.delete({ where: { id: fotoId } });
      const restantes = producto.fotos.filter((f) => f.id !== fotoId);
      for (const [index, f] of restantes.entries()) {
        await tx.foto.update({ where: { id: f.id }, data: { orden: index } });
      }
    });

    await limpiarMediaRemota(foto, "la foto", req);

    logAudit(req, {
      accion: "ELIMINAR_FOTO",
      entidad: "Producto",
      entidadId: id,
      detalle: { fotoId, nombreProducto: producto.nombre },
    });

    const productoActualizado = await prisma.product.findUniqueOrThrow({ where: { id }, include: PRODUCT_INCLUDE });
    res.json(mapProducto(productoActualizado, { esAdmin: true }));
  } catch (err) {
    next(err);
  }
}

/**
 * Dispara el flujo de generación de imágenes de n8n para un producto.
 *
 * Las referencias NO se persisten: llegan en memoria por multer, se reenvían a
 * n8n y se descartan. No tocan Cloudinary ni la tabla `Foto`.
 *
 * El payload sale de `mapProductoParaN8n`, no de `mapProducto`: el consumidor
 * es un agente de IA y todo lo que no describe al producto (ids de filas,
 * contadores, estado comercial) es ruido que le cuesta en cada ejecución.
 *
 * Responde cuando el webhook confirma la RECEPCIÓN, no cuando las imágenes
 * están listas — n8n responde de inmediato y sigue procesando por su cuenta.
 * Por eso el `estado` viaja en la respuesta: `already_processed` significa que
 * n8n NO generó nada, y la pantalla tiene que poder decirlo.
 */
export async function generarImagenes(req, res, next) {
  try {
    // Se chequea antes de leer la base: un deploy sin la variable tiene que
    // enterarse por el mensaje, no por un fallo opaco después del trabajo.
    if (!n8nEstaConfigurado()) {
      throw httpError(
        400,
        "La integración con n8n no está configurada. Falta N8N_WEBHOOK_IMAGENES en el servidor.",
      );
    }

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.findUnique({ where: { id }, include: PRODUCT_INCLUDE });
    if (!producto) throw httpError(404, "Producto no encontrado.");

    const referencias = req.files?.referencias ?? [];

    // El flujo de n8n usa `gpt-image-1` en operación `edit`, que NO puede
    // trabajar sin imagen de entrada: sin referencias responde 400. Se corta
    // acá para no gastar un viaje y para que el mensaje sea el de YIMA y no el
    // de un servicio que el admin no conoce.
    if (referencias.length === 0) {
      throw httpError(400, "Elegí al menos una imagen de referencia para generar.");
    }

    let resultado;
    try {
      resultado = await enviarPedidoDeImagenes({
        producto: mapProductoParaN8n(producto),
        referencias,
      });
    } catch (err) {
      // 503 cuando n8n avisó que abortó sin generar nada por no poder verificar
      // Cloudinary: es temporal y reintentable, y el código lo dice. Para el
      // resto, 502 — el que falló es un servicio de arriba, no este backend. En
      // los dos casos el mensaje del servicio ya es legible y viaja tal cual.
      //
      // OJO al diagnosticar: un 400 de n8n también cae en este 502, y ese caso
      // NO es un problema de n8n — significa que el payload que armó YIMA está
      // mal. Se muestra como 502 porque no es algo que el admin pueda arreglar,
      // pero si aparecen 400s en producción el lugar donde mirar es
      // `mapProductoParaN8n` y el armado del FormData, no el flujo.
      throw httpError(err.esReintentable ? 503 : 502, err.message);
    }

    // Después del éxito, nunca antes — mismo contrato que el resto de las
    // mutaciones auditadas. El estado entra en el detalle porque un
    // `already_processed` NO generó nada: sin eso, la traza haría creer que sí.
    logAudit(req, {
      accion: "GENERAR_IMAGENES",
      entidad: "Producto",
      entidadId: id,
      detalle: { referenciasEnviadas: referencias.length, estado: resultado.estado },
    });

    res.json({ enviado: true, estado: resultado.estado, carpeta: resultado.carpeta });
  } catch (err) {
    next(err);
  }
}
