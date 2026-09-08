import { prisma } from "../lib/prisma.js";
import { ESTADOS_TEMPORALES, estadoTemporal } from "../lib/campanias.js";
import { TIPOS_COMERCIALES, listaDeOrigenesComerciales } from "../lib/eventosComerciales.js";
import {
  ETAPAS_COMERCIALES,
  calcularTasaClicks,
  conteosVacios,
  finInclusivo,
  periodoDePromocion,
  repartirEtapas,
  repartirEventos,
} from "../lib/metricasComerciales.js";
import { aClaveDia } from "./admin.controller.js";

/**
 * Tope de ítems por tipo. Suficiente para años de campañas y evita cargar la
 * tabla entera. Es un tope, no una página: la pantalla no pagina.
 */
export const MAX_ITEMS_METRICAS = 50;

/**
 * `GET /admin/metricas-comerciales` — impresiones, clicks, tasa y etapas por
 * campaña y por promoción, cada una acotada a SU período. Sin `?dias=`: acá
 * el período no lo pide el admin, lo tiene cada ítem.
 *
 * **Estrategia de consulta**, como en `embudoConversion`: todo se agrega en
 * la base con `groupBy` y se reparte en memoria con las funciones puras de
 * `lib/metricasComerciales.js`. NUNCA se cargan filas de `EventoTrafico`.
 * Cuatro consultas fijas, sin importar cuántos ítems haya:
 *
 *   1. el arranque global de la medición (`_min(createdAt)` de los dos tipos
 *      comerciales) — sin filtro de fecha a propósito, es "desde cuándo
 *      existe esto";
 *   2. los eventos por campaña, cada una en SU período;
 *   3. los eventos por promoción, ídem;
 *   4. las etapas (`VISTA_PRODUCTO`, `AGREGADO_CARRITO`) por producto, para
 *      los productos de TODAS las vitrinas del lote, en el rango total.
 *      `productosDelLote` va DEDUPLICADO con `Set` antes de armar el `in`:
 *      el tope de 2.100 parámetros de SQL Server (la misma trampa que
 *      `?promocion=` documenta en `CLAUDE.md`) lo acota el tamaño del
 *      CATÁLOGO, no la cantidad de campañas o promociones del lote.
 *
 * ⚠️ **La 2 y la 3 acotan al período de CADA ítem, con un `OR` de rangos, y
 * eso no es cosmética: es lo que sostiene que la ESCRITURA no valide la
 * vigencia.** `eventosComerciales.controller.js` acepta un evento contra una
 * campaña FINALIZADA a propósito, y el argumento es que la lectura lo va a
 * descartar. Con un rango único —el `min` de todos los `desde` al `max` de
 * todos los `hasta`— eso era FALSO: bastaba una campaña vigente para que un
 * evento posteado hoy contra una campaña de enero cayera adentro y se
 * contara, o sea que un anónimo podía inflar los números de cualquier campaña
 * terminada. Sigue siendo UNA consulta por lado (con el tope de 50, ≤50
 * cláusulas y ~150 parámetros); un query por ítem es justo lo que la
 * estrategia evita.
 *
 * ⚠️ **Y el `OR` vacío no filtra nada en Prisma: trae la tabla entera.** Por
 * eso cada lado se saltea cuando no tiene ítems. El early return cubre "cero
 * ítems en total", pero un `?estado=` puede dejar promociones y CERO campañas.
 *
 * ⚠️ **El truncado NO filtra por `?estado=`**: `take: MAX_ITEMS_METRICAS`
 * trae las más recientes de cada tabla y el filtro de `?estado=` corre
 * DESPUÉS, en memoria, porque `estadoTemporal` es derivado y no tiene
 * columna (no hay `where` posible). Con más de `MAX_ITEMS_METRICAS`
 * campañas, un `?estado=FINALIZADA` puede devolver `items: []` sin que
 * signifique "no hay finalizadas" — significa "no entraron en el corte de
 * las más recientes". Por eso el sobre declara `truncado`, mismo criterio
 * que `periodo.recortado` en las cuatro pantallas de analytics.
 *
 * ⚠️ **La 4 SÍ queda en el rango total, y el sobre lo declara en
 * `etapasEnRango`.** Un `groupBy` por `[productId, tipo]` no puede acotarse al
 * período de cada ítem: con un `OR` de rangos distintos el motor no puede
 * decir de qué rama vino cada conteo, y un producto puede estar en dos
 * vitrinas a la vez —que es justo lo que `repartirEtapas` resuelve sumándolo
 * en las dos—. Partirlo sería una consulta por campaña.
 *
 * **No es una imprecisión despreciable, y no hace falta que las campañas se
 * solapen**: con una campaña de enero y otra vigente hoy, el rango total va de
 * enero a hoy, así que la de enero reporta NUEVE MESES de vistas de sus
 * productos al lado de un `periodo` de quince días. Por eso el rango real
 * viaja en el sobre en vez de quedar solo en este comentario: la pantalla
 * puede decir sobre qué ventana se contaron esas dos filas.
 */
export async function metricasComerciales(req, res, next) {
  try {
    const ahora = new Date();
    const filtroEstado = ESTADOS_TEMPORALES.includes(req.query?.estado)
      ? req.query.estado
      : null;

    const [campanias, promociones, arranques] = await Promise.all([
      prisma.campania.findMany({
        orderBy: { desde: "desc" },
        take: MAX_ITEMS_METRICAS,
        select: {
          id: true,
          nombre: true,
          estado: true,
          desde: true,
          hasta: true,
          productos: { select: { productId: true } },
        },
      }),
      prisma.promocion.findMany({
        orderBy: { id: "desc" },
        take: MAX_ITEMS_METRICAS,
        select: {
          id: true,
          nombre: true,
          activa: true,
          items: { where: { habilitado: true }, select: { productId: true } },
          programaciones: { select: { desde: true, hasta: true, habilitada: true } },
          campanias: { select: { campania: { select: { desde: true, hasta: true } } } },
        },
      }),
      prisma.eventoTrafico.groupBy({
        by: ["tipo"],
        where: { tipo: { in: TIPOS_COMERCIALES } },
        _min: { createdAt: true },
      }),
    ]);

    // El arranque global: el primer evento comercial de toda la historia.
    const arranque = arranques
      .map((fila) => fila._min?.createdAt)
      .filter(Boolean)
      .map((fecha) => new Date(fecha))
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

    // El `take` recortó alguna de las dos tablas: ver la nota del docblock
    // sobre por qué esto NO se resuelve filtrando por estado en la base.
    const truncado =
      campanias.length === MAX_ITEMS_METRICAS || promociones.length === MAX_ITEMS_METRICAS;

    // Los ítems con su período. Una promoción sin período queda afuera.
    const items = [
      ...campanias.map((c) => ({
        tipo: "CAMPANIA",
        id: c.id,
        nombre: c.nombre,
        estado: c.estado,
        periodo: { desde: new Date(c.desde), hasta: new Date(c.hasta) },
        productos: new Set(c.productos.map((p) => p.productId)),
      })),
      ...promociones
        // Una promoción ASOCIADA A UNA CAMPAÑA no entra al carrusel
        // (`slidesDePromociones` la excluye con `campanias: { none: {} }`),
        // así que no tiene ninguna superficie y no puede generar un solo
        // evento. Sin este filtro entraba igual —`periodoDePromocion` le da
        // período con las campañas asociadas— y salía con impresiones y
        // clicks en cero ESTRUCTURAL (no "no vino nadie") más unas etapas que
        // son las vistas de los productos de su campaña, o sea el mismo
        // número dibujado dos veces en la pantalla. Una fila donde ningún dato
        // es propio no es un dato incompleto: es una afirmación falsa.
        // ⚠️ Si algún día una promoción con campaña vuelve a tener superficie
        // propia, esto se saca ACÁ y no en `periodoDePromocion`, que sigue
        // siendo la definición general del período.
        .filter((p) => p.campanias.length === 0)
        .map((p) => ({ promocion: p, periodo: periodoDePromocion(p) }))
        .filter(({ periodo }) => periodo !== null)
        .map(({ promocion, periodo }) => ({
          tipo: "PROMOCION",
          id: promocion.id,
          nombre: promocion.nombre,
          activa: promocion.activa,
          periodo,
          productos: new Set(promocion.items.map((i) => i.productId)),
        })),
    ]
      .map((item) => ({ ...item, estadoTemporal: estadoTemporal(item.periodo, ahora) }))
      .filter((item) => filtroEstado === null || item.estadoTemporal === filtroEstado)
      .sort((a, b) => b.periodo.desde.getTime() - a.periodo.desde.getTime());

    const origenes = listaDeOrigenesComerciales();

    if (items.length === 0) {
      res.json({
        registraDesde: arranque ? aClaveDia(arranque) : null,
        truncado,
        // Sin ítems no hay rango que declarar, pero la clave viaja igual: un
        // sobre que a veces la trae y a veces no obliga a la pantalla a
        // distinguir "no vino" de "no aplica".
        etapasEnRango: null,
        origenes,
        items: [],
      });
      return;
    }

    // El rango TOTAL del lote. Ya NO acota los eventos —cada ítem lleva el
    // suyo—, solo las etapas, que agrupan por producto y no se pueden partir.
    const rangoTotal = {
      gte: new Date(Math.min(...items.map((i) => i.periodo.desde.getTime()))),
      lte: finInclusivo(new Date(Math.max(...items.map((i) => i.periodo.hasta.getTime())))),
    };
    // Una rama del `OR` por ítem: su id MÁS su propio rango. Como el `by` ya
    // lleva `campaniaId`/`promocionId`, la atribución de cada fila es exacta.
    const ramasDe = (tipo, clave) =>
      items
        .filter((i) => i.tipo === tipo)
        .map((i) => ({
          [clave]: i.id,
          createdAt: { gte: i.periodo.desde, lte: finInclusivo(i.periodo.hasta) },
        }));
    const ramasCampania = ramasDe("CAMPANIA", "campaniaId");
    const ramasPromocion = ramasDe("PROMOCION", "promocionId");
    const productosDelLote = [...new Set(items.flatMap((i) => [...i.productos]))];

    const [porCampania, porPromocion, etapasCrudas] = await Promise.all([
      // El lado sin ítems NO corre: `OR: []` en Prisma no filtra nada y
      // devolvería la tabla entera, atribuyéndole a cada campaña eventos de
      // cualquier fecha.
      ramasCampania.length === 0
        ? []
        : prisma.eventoTrafico.groupBy({
            by: ["campaniaId", "tipo", "origen", "destino"],
            where: { tipo: { in: TIPOS_COMERCIALES }, OR: ramasCampania },
            _count: { _all: true },
          }),
      ramasPromocion.length === 0
        ? []
        : prisma.eventoTrafico.groupBy({
            by: ["promocionId", "tipo", "origen", "destino"],
            where: { tipo: { in: TIPOS_COMERCIALES }, OR: ramasPromocion },
            _count: { _all: true },
          }),
      productosDelLote.length === 0
        ? []
        : prisma.eventoTrafico.groupBy({
            by: ["productId", "tipo"],
            where: {
              productId: { in: productosDelLote },
              tipo: { in: ETAPAS_COMERCIALES.map((e) => e.tipo) },
              createdAt: rangoTotal,
            },
            _count: { _all: true },
          }),
    ]);

    const eventosCampania = repartirEventos(porCampania, "campaniaId");
    const eventosPromocion = repartirEventos(porPromocion, "promocionId");
    const vitrinas = new Map(items.map((i) => [`${i.tipo}:${i.id}`, i.productos]));
    const etapasPorItem = repartirEtapas(etapasCrudas, vitrinas);

    const salida = items.map((item) => {
      const conteos =
        (item.tipo === "CAMPANIA" ? eventosCampania : eventosPromocion).get(item.id) ??
        conteosVacios();
      const etapas = etapasPorItem.get(`${item.tipo}:${item.id}`) ?? {};

      return {
        tipo: item.tipo,
        id: item.id,
        nombre: item.nombre,
        ...(item.tipo === "CAMPANIA" ? { estado: item.estado } : { activa: item.activa }),
        estadoTemporal: item.estadoTemporal,
        periodo: { desde: aClaveDia(item.periodo.desde), hasta: aClaveDia(item.periodo.hasta) },
        // Empezó antes de que la medición existiera: sus números están
        // subcontados. Es el mecanismo del Embudo, aplicado al período del
        // ítem en vez de al período pedido. Sin arranque, todo es subregistrado.
        subregistrada:
          arranque === null || aClaveDia(item.periodo.desde) < aClaveDia(arranque),
        impresiones: conteos.impresiones,
        clicks: conteos.clicks,
        tasaClicks: Object.fromEntries(
          Object.keys(conteos.impresiones).map((origen) => [
            origen,
            calcularTasaClicks(conteos.clicks[origen] ?? 0, conteos.impresiones[origen] ?? 0),
          ]),
        ),
        clicksPorDestino: conteos.clicksPorDestino,
        etapas: ETAPAS_COMERCIALES.map((e) => ({
          clave: e.clave,
          etiqueta: e.etiqueta,
          cantidad: etapas[e.clave] ?? 0,
        })),
      };
    });

    res.json({
      registraDesde: arranque ? aClaveDia(arranque) : null,
      truncado,
      // Sobre qué ventana se contaron las `etapas` de TODOS los ítems. Es el
      // rango total del lote y puede ser mucho más ancho que el `periodo` de
      // un ítem viejo: se declara en vez de quedar escondido en un comentario.
      etapasEnRango: { desde: aClaveDia(rangoTotal.gte), hasta: aClaveDia(rangoTotal.lte) },
      origenes,
      items: salida,
    });
  } catch (err) {
    next(err);
  }
}
