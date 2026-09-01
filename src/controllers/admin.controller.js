import { Decimal } from "@prisma/client/runtime/client.js";
import { prisma } from "../lib/prisma.js";
import { parsearPaginacion } from "../lib/paginacion.js";
import { subtotalDeItem, sumarDecimales } from "../lib/dinero.js";
import { claveDiaArgentino, inicioDelDiaArgentino } from "../lib/horarioArgentino.js";

export async function listarErrorLogs(req, res, next) {
  try {
    const { page, pageSize } = parsearPaginacion(req.query);

    const [total, errorLogs] = await Promise.all([
      prisma.errorLog.count(),
      prisma.errorLog.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ data: errorLogs, page, pageSize, total });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/audit-logs — traza de auditoría paginada del panel admin
 * (quién hizo qué mutación y cuándo). Protegida por el `router.use(requireAuth)`
 * de `admin.routes.js`, igual que `listarErrorLogs`.
 *
 * Misma paginación y mismo shape de respuesta (`{ data, page, pageSize, total }`)
 * que el listado de error logs — el frontend (`AdminLogs.jsx`) consume ambas
 * pestañas con la misma lógica de paginación.
 *
 * Filtro opcional por `entidad` (Producto | Orden | Usuario | Categoria). Un
 * valor vacío se ignora en vez de filtrar por string vacío (que no traería
 * nada). Alineado con el índice `[entidad, createdAt]` del modelo.
 */
export async function listarAuditLogs(req, res, next) {
  try {
    const { page, pageSize } = parsearPaginacion(req.query);

    const where = {};
    if (typeof req.query.entidad === "string" && req.query.entidad !== "") {
      where.entidad = req.query.entidad;
    }

    const [total, auditLogs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ data: auditLogs, page, pageSize, total });
  } catch (err) {
    next(err);
  }
}

/**
 * Estados que cuentan como venta concretada.
 *
 * El umbral es EN_PREPARACION en adelante, y no es arbitrario: son exactamente
 * los estados en los que `ordenes.controller.js` toma el stock
 * (`ESTADOS_CON_STOCK_TOMADO`), o sea el momento en que el sistema ya da la
 * mercadería por salida. Una métrica de facturación con otro umbral
 * contradiría la lógica de stock. PENDIENTE y CANCELADA quedan afuera a
 * propósito.
 *
 * Coincide valor por valor con `ESTADOS_CON_STOCK_TOMADO` y se mantiene
 * aparte: esta responde "¿cuento esto como plata?" y aquella "¿saqué esto del
 * depósito?". Hoy la respuesta es la misma; podrían divergir.
 */
export const ESTADOS_FACTURABLES = ["EN_PREPARACION", "ENTREGADA"];

/** Período por defecto cuando no llega `desde`/`hasta` en la query. */
const DIAS_PERIODO_POR_DEFECTO = 30;

/** Tope de productos devueltos en el ranking de facturación. */
const TOP_RANKING = 10;

/**
 * Tope de días que puede abarcar el período. La serie temporal rellena con
 * `"0"` los días sin ventas (para que el gráfico no comprima el eje y
 * disimule un bache), así que el largo de la respuesta lo fija el rango, no
 * el volumen de datos: pedir 10 años devolvía ~3650 puntos y ~150KB casi
 * todos vacíos. Un poco más de un año cubre cualquier comparación
 * interanual razonable; más que eso es un gráfico ilegible, no un análisis.
 */
const MAX_DIAS_PERIODO = 400;

/**
 * Tope de órdenes que se traen para el resumen de ventas (y, vía import, para
 * `clientes-resumen` en `adminClientes.controller.js` — un solo dueño, ver
 * "Módulos compartidos" del CLAUDE.md).
 *
 * El filtro de período acota los DÍAS (máx. 400), pero no las FILAS: un
 * período válido con muchas órdenes se cargaba y reducía entero en memoria.
 * Mismo patrón que `clientes-resumen`: se pide UNA fila de más que el tope
 * para detectar el corte sin adivinar, se conservan las MÁS RECIENTES
 * (`orderBy: createdAt desc`) y la respuesta lo declara en
 * `historico: { ordenesAnalizadas, tope, recortado }`. Con `recortado: true`
 * los totales del período son un PISO, no la verdad — el flag existe para que
 * la pantalla lo diga en vez de mentir en silencio. Es un flag DISTINTO de
 * `periodo.recortado`, que habla del rango de fechas.
 *
 * 20.000 es holgado para este negocio (~55 órdenes confirmadas por día
 * sostenidas un año) y sigue siendo barato de reducir en O(n).
 */
export const MAX_ORDENES_HISTORICO = 20000;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * `Date` -> "YYYY-MM-DD" del día ARGENTINO, la misma clave que agrupa la serie
 * diaria.
 *
 * Era `fecha.toISOString().slice(0, 10)`, o sea el día UTC, y eso corría de
 * lugar todas las ventas de la tarde-noche: el contenedor corre en UTC, el
 * negocio vive en Buenos Aires (UTC-3), así que una orden de las 21:00 de acá
 * caía en el punto del día SIGUIENTE del gráfico. El rótulo del eje quedaba
 * bien y el número de atrás estaba corrido — la peor combinación, porque nada
 * la delata.
 *
 * El desfase sale de `lib/horarioArgentino.js`, el mismo módulo que usan las
 * plantillas de correo para fechar el comprobante del cliente: dos definiciones
 * de "día" en el mismo sistema serían dos números que se contradicen sin error.
 */
export function aClaveDia(fecha) {
  return claveDiaArgentino(fecha);
}

/**
 * Parsea `desde`/`hasta` de la query string con el mismo criterio defensivo
 * que `parsearPaginacion`: una fecha ausente, malformada o no parseable cae al
 * período por defecto (últimos 30 días) en vez de tirar 500.
 *
 * `hasta` es inclusivo — se extiende al final del día (23:59:59.999) para que
 * pedir `hasta=2026-08-15` incluya las órdenes de ese mismo día y no las
 * corte a medianoche. Si el rango viene invertido (`desde` posterior a
 * `hasta`) se dan vuelta los extremos, que es más útil que devolver vacío.
 *
 * **Los límites son las medianoches ARGENTINAS, expresadas como instantes UTC.**
 * `desde`/`hasta` se comparan contra `Orden.createdAt`, que la base guarda en
 * UTC, así que tienen que seguir siendo instantes UTC válidos — lo que cambió
 * es a qué momento corresponden: `2026-08-15` es `2026-08-15T03:00:00.000Z`, la
 * medianoche de Buenos Aires, y no la de Greenwich. Anclarlos en `T00:00:00Z`
 * hacía que "últimos 30 días" arrancara y terminara a las 21:00 hora local, con
 * las ventas de esas tres horas contadas del lado equivocado del corte.
 */
export function parsearPeriodo(query) {
  const parsear = (valor) => {
    if (typeof valor !== "string" || valor === "") return null;
    return inicioDelDiaArgentino(valor.slice(0, 10));
  };

  const hoy = inicioDelDiaArgentino(aClaveDia(new Date()));

  let desde = parsear(query.desde);
  let hasta = parsear(query.hasta);

  if (hasta === null) hasta = hoy;
  if (desde === null) {
    desde = new Date(hasta.getTime() - (DIAS_PERIODO_POR_DEFECTO - 1) * MS_POR_DIA);
  }

  if (desde.getTime() > hasta.getTime()) {
    [desde, hasta] = [hasta, desde];
  }

  // Recorte por el tope de días (ver `MAX_DIAS_PERIODO`). Se conserva `hasta`
  // y se corre `desde` hacia adelante: ante un rango imposible interesa el
  // tramo más reciente, no el arranque histórico. `recortado` viaja en la
  // respuesta para que la UI pueda avisar que el período mostrado no es el
  // pedido, en vez de mentir en silencio.
  let recortado = false;
  const diasDelRango = Math.round((hasta.getTime() - desde.getTime()) / MS_POR_DIA) + 1;
  if (diasDelRango > MAX_DIAS_PERIODO) {
    desde = new Date(hasta.getTime() - (MAX_DIAS_PERIODO - 1) * MS_POR_DIA);
    recortado = true;
  }

  const hastaInclusive = new Date(hasta.getTime() + MS_POR_DIA - 1);

  return { desde, hasta, hastaInclusive, recortado };
}

/**
 * GET /api/admin/ventas — resumen de facturación del período. Protegida por el
 * `router.use(requireAuth)` de `admin.routes.js`, igual que los otros feeds.
 *
 * **Precisión monetaria**: los montos se calculan con `Decimal` (el mismo tipo
 * que Prisma devuelve para `precioUnitario`, que es `Decimal(10,0)`), nunca con
 * aritmética float. Acumular en `number` deriva: sumar `0.10 * 7` diez veces da
 * `7.000000000000001` en float y `7.00` exacto en Decimal. Que los montos hoy
 * sean enteros NO vuelve seguro el float: los promedios (`ticketPromedio`,
 * `valorPromedioPorCliente`) dividen, y ahí la parte fraccionaria vuelve a
 * aparecer antes de redondearse.
 *
 * Los montos salen serializados como string ENTERO (`.toFixed(0)`), siguiendo
 * el precedente de `mapProducto` en `products.controller.js` — el frontend ya
 * espera precios como string y los formatea con `formatPrecio`. Ese `toFixed(0)`
 * es además el redondeo real de los promedios: un ticket promedio de
 * `1500.5` se publica como `"1501"`, no como `"1500.5"`.
 *
 * **Origen de los montos**: siempre los snapshots de `ItemOrden`
 * (`precioUnitario * cantidad`), nunca el `precio` vivo del `Product`. Un
 * cambio de precio no debe reescribir la facturación histórica.
 *
 * **Estrategia de consulta**: una sola query trae las órdenes del período con
 * sus items, y el resto se reduce en memoria en O(n) sobre los items. No se usa
 * `groupBy`/`aggregate` de Prisma porque no sabe agregar una *expresión*
 * (`precioUnitario * cantidad`): sumar cada columna por separado daría un
 * resultado matemáticamente incorrecto. La alternativa sería SQL crudo, que
 * costaría portabilidad y testabilidad para un volumen de datos chico. Lo que
 * sí se evita es la trampa real: nada de una query por producto (N+1) para
 * armar el ranking — se agrupa en el mismo recorrido.
 */
export async function resumenVentas(req, res, next) {
  try {
    const { desde, hasta, hastaInclusive, recortado } = parsearPeriodo(req.query);

    // Techo de filas con detección de corte: ver `MAX_ORDENES_HISTORICO`.
    const filas = await prisma.orden.findMany({
      where: { createdAt: { gte: desde, lte: hastaInclusive } },
      orderBy: { createdAt: "desc" },
      take: MAX_ORDENES_HISTORICO + 1,
      select: {
        id: true,
        estado: true,
        createdAt: true,
        items: {
          select: {
            productId: true,
            nombreProducto: true,
            precioUnitario: true,
            cantidad: true,
          },
        },
      },
    });

    const historicoRecortado = filas.length > MAX_ORDENES_HISTORICO;
    const ordenes = historicoRecortado ? filas.slice(0, MAX_ORDENES_HISTORICO) : filas;

    let ingresosTotales = new Decimal(0);
    let cantidadOrdenes = 0;
    let unidadesVendidas = 0;
    let itemsFacturados = 0;

    let pipelineValor = new Decimal(0);
    let pipelineOrdenes = 0;
    let ordenesCanceladas = 0;

    // productId -> { productId, nombre, unidades, facturacion }
    const porProducto = new Map();
    // "YYYY-MM-DD" -> Decimal de ingresos de ese día
    const porDia = new Map();

    for (const orden of ordenes) {
      if (orden.estado === "CANCELADA") {
        ordenesCanceladas += 1;
        continue;
      }

      // Los subtotales por ítem se calculan UNA sola vez: el total de la orden
      // es su suma, y el ranking por producto de más abajo los reusa por
      // índice. Antes se multiplicaba `precioUnitario * cantidad` dos veces
      // por ítem, una acá y otra en el ranking.
      const subtotales = orden.items.map(subtotalDeItem);
      const totalOrden = sumarDecimales(subtotales);

      if (orden.estado === "PENDIENTE") {
        // Pipeline: ingreso potencial, todavía no facturado. Se reporta
        // separado para que nunca se lea como plata ya ganada.
        pipelineOrdenes += 1;
        pipelineValor = pipelineValor.plus(totalOrden);
        continue;
      }

      if (!ESTADOS_FACTURABLES.includes(orden.estado)) continue;

      cantidadOrdenes += 1;
      ingresosTotales = ingresosTotales.plus(totalOrden);
      itemsFacturados += orden.items.length;

      const dia = aClaveDia(orden.createdAt);
      porDia.set(dia, (porDia.get(dia) ?? new Decimal(0)).plus(totalOrden));

      for (const [indice, item] of orden.items.entries()) {
        unidadesVendidas += item.cantidad;

        const facturacionItem = subtotales[indice];

        // Clave del agrupamiento: el id del producto, y el snapshot del nombre
        // cuando ese id ya no existe.
        //
        // `ItemOrden.productId` es nullable desde que borrar un producto
        // desliga sus líneas (`onDelete: SetNull`). Agrupar por `productId` a
        // secas metía a TODOS los productos borrados en la misma entrada —la
        // clave `null`— y sumaba la facturación de productos distintos bajo el
        // nombre del primero que apareciera. Sin error y sin aviso: un número
        // inventado en el ranking que mira el negocio.
        const clave = item.productId ?? `eliminado:${item.nombreProducto}`;
        const acumulado = porProducto.get(clave);

        if (acumulado) {
          acumulado.unidades += item.cantidad;
          acumulado.facturacion = acumulado.facturacion.plus(facturacionItem);
        } else {
          porProducto.set(clave, {
            // Se emite `null`, no la clave sintética: para el consumidor
            // "este producto ya no existe" y "este producto es el 7" son
            // cosas distintas, y un id inventado sería peor que ninguno.
            productId: item.productId ?? null,
            // Se usa el snapshot `nombreProducto`, no el nombre vivo del
            // producto, por la misma razón que el precio: la orden histórica
            // no se reescribe si el producto se renombra después.
            nombre: item.nombreProducto,
            unidades: item.cantidad,
            facturacion: facturacionItem,
          });
        }
      }
    }

    const totalOrdenesPeriodo = ordenes.length;

    // Ranking por FACTURACIÓN, no por unidades: son rankings distintos y el
    // que importa para el negocio es cuánta plata genera cada producto.
    const rankingProductos = [...porProducto.values()]
      .sort((a, b) => b.facturacion.comparedTo(a.facturacion))
      .slice(0, TOP_RANKING)
      .map((producto) => ({
        productId: producto.productId,
        nombre: producto.nombre,
        unidades: producto.unidades,
        facturacion: producto.facturacion.toFixed(0),
      }));

    // La serie incluye TODOS los días del rango, también los que no tuvieron
    // ventas (en cero), para que el gráfico no comprima el eje temporal y se
    // vea el hueco real en vez de dos días con ventas pegados uno al otro.
    const serieTemporal = [];
    for (let dia = new Date(desde.getTime()); dia <= hasta; dia = new Date(dia.getTime() + MS_POR_DIA)) {
      const clave = aClaveDia(dia);
      serieTemporal.push({
        fecha: clave,
        ingresos: (porDia.get(clave) ?? new Decimal(0)).toFixed(0),
      });
    }

    // Divisiones protegidas: sin órdenes en el período todo da 0, nunca
    // NaN/Infinity (que romperían el formateo en el frontend).
    const ticketPromedio =
      cantidadOrdenes > 0 ? ingresosTotales.div(cantidadOrdenes).toFixed(0) : "0";
    const productosPorOrden =
      cantidadOrdenes > 0 ? Math.round((itemsFacturados / cantidadOrdenes) * 100) / 100 : 0;
    const tasaCancelacion =
      totalOrdenesPeriodo > 0
        ? Math.round((ordenesCanceladas / totalOrdenesPeriodo) * 10000) / 10000
        : 0;

    res.json({
      periodo: { desde: aClaveDia(desde), hasta: aClaveDia(hasta), recortado },
      // Mismo criterio que `clientes-resumen`: si se recortó el histórico,
      // los totales son un piso y la respuesta lo declara.
      historico: {
        ordenesAnalizadas: ordenes.length,
        tope: MAX_ORDENES_HISTORICO,
        recortado: historicoRecortado,
      },
      ingresosTotales: ingresosTotales.toFixed(0),
      cantidadOrdenes,
      ticketPromedio,
      unidadesVendidas,
      productosPorOrden,
      pipeline: {
        cantidadOrdenes: pipelineOrdenes,
        valorTotal: pipelineValor.toFixed(0),
      },
      ordenesCanceladas,
      tasaCancelacion,
      rankingProductos,
      serieTemporal,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Etapas del embudo global, en orden. Es GLOBAL (de todo el sitio), no por
 * producto: `ORDEN_CREADA` no lleva `productId` (una orden puede abarcar
 * varios productos), así que un embudo por producto se cortaría justo en el
 * paso que más importa.
 *
 * `tipo: null` marca la etapa que NO sale de `EventoTrafico`: las órdenes
 * confirmadas se cuentan de la tabla `Orden` por `estado`, porque confirmar
 * es una acción de admin y nunca emitió un evento de tráfico.
 */
const ETAPAS_EMBUDO = [
  { clave: "VISTAS", etiqueta: "Vistas", tipo: "VISTA_PRODUCTO" },
  { clave: "CARRITO", etiqueta: "Carrito", tipo: "AGREGADO_CARRITO" },
  { clave: "ORDENES_CREADAS", etiqueta: "Órdenes creadas", tipo: "ORDEN_CREADA" },
  { clave: "ORDENES_CONFIRMADAS", etiqueta: "Órdenes confirmadas", tipo: null },
];

/** Tope de filas devueltas en la tabla de fuentes de tráfico. */
const TOP_FUENTES = 15;

/** Etiqueta del bucket de visitas sin referrer (entrada directa). */
const FUENTE_DIRECTA = "Directo";

/**
 * Normaliza un `referrer` a su host, para que la tabla agrupe por origen y no
 * escupa una fila por URL. `https://www.instagram.com/yima/post/123` y
 * `https://instagram.com/otro` colapsan los dos en `instagram.com`.
 *
 * Un referrer ausente o vacío es una visita directa (link pegado, marcador,
 * app sin referrer) y va a su propio bucket etiquetado, no al montón de
 * "desconocido" ni descartado — es información real, no un dato faltante.
 *
 * Un valor que no parsea como URL se devuelve tal cual en vez de perderse:
 * ver un origen raro es más útil que ver un agujero en los totales.
 */
function normalizarFuente(referrer) {
  if (typeof referrer !== "string" || referrer.trim() === "") return FUENTE_DIRECTA;

  try {
    const host = new URL(referrer).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return referrer;
  }
}

/**
 * GET /api/admin/embudo — embudo de conversión global del sitio. Protegida por
 * el `router.use(requireAuth)` de `admin.routes.js`, igual que `/ventas`.
 *
 * **Honestidad del dato — la parte que más importa de este endpoint.** Los
 * emisores de eventos se cablearon en momentos distintos: los de carrito y
 * orden existen desde antes que el de vista de producto. Comparar en crudo
 * conteos que arrancaron en fechas distintas produce números absurdos (con 1
 * vista y 72 agregados al carrito, la "conversión" da 7200%), y un dashboard
 * que miente con confianza es peor que no tener dashboard: destruye la
 * confianza en todas las otras métricas de la pantalla.
 *
 * Por eso la respuesta lleva, además de los conteos:
 *  - `registraDesde` por etapa: cuándo empezó a registrarse ESE tipo de evento
 *    (`MIN(createdAt)` agrupado por tipo, en la base, sin traer filas).
 *  - `subregistrada` por etapa: si el período pedido arranca ANTES de esa
 *    fecha, o sea si ese número está subcontado frente a los demás.
 *  - `confiableDesde`: la MÁS TARDÍA de esas fechas — el día a partir del cual
 *    todas las etapas del embudo están registrando de verdad.
 *  - `periodoConfiable`: si el período pedido entra entero en esa ventana.
 *
 * Y ninguna tasa puede superar el 100%: si una etapa tiene más eventos que la
 * anterior, la tasa sale `null` con `tasaCalculable: false` para que la UI
 * muestre "—" en vez de un porcentaje imposible.
 *
 * **Estrategia de consulta**: todo se agrega en la base (`groupBy` con
 * `_count`/`_min`, `count`), nunca cargando filas de `EventoTrafico` a
 * memoria — es la tabla que más crece del modelo.
 */
export async function embudoConversion(req, res, next) {
  try {
    const { desde, hasta, hastaInclusive, recortado } = parsearPeriodo(req.query);

    const tiposDeEvento = ETAPAS_EMBUDO.map((etapa) => etapa.tipo).filter(Boolean);

    const [arranquesPorTipo, conteosPorTipo, ordenesConfirmadas, referrersCrudos] =
      await Promise.all([
        // Sin filtro de período a propósito: es la fecha del PRIMER evento de
        // cada tipo en toda la historia, no dentro del rango pedido.
        prisma.eventoTrafico.groupBy({
          by: ["tipo"],
          _min: { createdAt: true },
        }),
        prisma.eventoTrafico.groupBy({
          by: ["tipo"],
          where: {
            tipo: { in: tiposDeEvento },
            createdAt: { gte: desde, lte: hastaInclusive },
          },
          _count: { _all: true },
        }),
        prisma.orden.count({
          where: {
            estado: { in: ESTADOS_FACTURABLES },
            createdAt: { gte: desde, lte: hastaInclusive },
          },
        }),
        prisma.eventoTrafico.groupBy({
          by: ["referrer"],
          where: { createdAt: { gte: desde, lte: hastaInclusive } },
          _count: { _all: true },
        }),
      ]);

    const arranquePorTipo = new Map(
      arranquesPorTipo
        .filter((fila) => fila._min?.createdAt)
        .map((fila) => [fila.tipo, new Date(fila._min.createdAt)]),
    );
    const conteoPorTipo = new Map(
      conteosPorTipo.map((fila) => [fila.tipo, fila._count?._all ?? 0]),
    );

    // El arranque de la etapa de órdenes confirmadas se toma del evento
    // ORDEN_CREADA: una orden no puede confirmarse sin haberse creado antes,
    // así que ese es el piso real de registro de la etapa.
    const arranqueDeEtapa = (etapa) =>
      arranquePorTipo.get(etapa.tipo ?? "ORDEN_CREADA") ?? null;

    // `confiableDesde` = la MÁS TARDÍA de las fechas de arranque de las etapas
    // del embudo. Antes de ese día, al menos una etapa no estaba registrando y
    // las tasas comparan cosas que no son comparables. Si alguna etapa nunca
    // registró nada, no hay ventana confiable en absoluto.
    let confiableDesde = null;
    let ventanaIncompleta = false;
    for (const etapa of ETAPAS_EMBUDO) {
      const arranque = arranqueDeEtapa(etapa);
      if (arranque === null) {
        ventanaIncompleta = true;
        continue;
      }
      if (confiableDesde === null || arranque.getTime() > confiableDesde.getTime()) {
        confiableDesde = arranque;
      }
    }
    if (ventanaIncompleta) confiableDesde = null;

    const etapas = ETAPAS_EMBUDO.map((etapa, indice) => {
      const cantidad =
        etapa.tipo === null ? ordenesConfirmadas : (conteoPorTipo.get(etapa.tipo) ?? 0);
      const arranque = arranqueDeEtapa(etapa);

      return {
        clave: etapa.clave,
        etiqueta: etapa.etiqueta,
        cantidad,
        registraDesde: arranque === null ? null : aClaveDia(arranque),
        // El período empieza antes de que esta etapa registrara: su número
        // está subcontado frente al de las etapas que ya venían registrando.
        // Se compara a nivel día porque el período se pide por día.
        subregistrada:
          arranque === null ? true : aClaveDia(desde) < aClaveDia(arranque),
        // Se completan abajo, cuando ya están todos los conteos.
        tasaDesdeAnterior: null,
        tasaCalculable: indice === 0 ? false : true,
      };
    });

    /**
     * Tasa etapa→etapa, redondeada a 4 decimales (misma precisión que
     * `tasaCancelacion` en `resumenVentas`).
     *
     * Devuelve `null` en los dos casos en que el número no significaría nada:
     * denominador cero (no hay con qué dividir) y numerador mayor que el
     * denominador (más conversiones que oportunidades — imposible en un
     * embudo real, síntoma de que las dos etapas no cubren el mismo período
     * de registro). Nunca se emite un porcentaje mayor a 100%.
     */
    function calcularTasa(cantidad, anterior) {
      if (anterior <= 0) return null;
      if (cantidad > anterior) return null;
      return Math.round((cantidad / anterior) * 10000) / 10000;
    }

    for (let indice = 1; indice < etapas.length; indice += 1) {
      const tasa = calcularTasa(etapas[indice].cantidad, etapas[indice - 1].cantidad);
      etapas[indice].tasaDesdeAnterior = tasa;
      etapas[indice].tasaCalculable = tasa !== null;
    }

    const tasaGlobal = calcularTasa(etapas[etapas.length - 1].cantidad, etapas[0].cantidad);

    // Fuentes de tráfico: se agrupan por host DESPUÉS del `groupBy` de la base
    // (que agrupa por URL completa) porque SQL no sabe extraer el host. El
    // volumen acá es de URLs distintas, no de eventos, así que es chico.
    const porFuente = new Map();
    for (const fila of referrersCrudos) {
      const fuente = normalizarFuente(fila.referrer);
      porFuente.set(fuente, (porFuente.get(fuente) ?? 0) + (fila._count?._all ?? 0));
    }

    const fuentesTrafico = [...porFuente.entries()]
      .map(([fuente, cantidad]) => ({ fuente, cantidad }))
      .sort((a, b) => b.cantidad - a.cantidad)
      .slice(0, TOP_FUENTES);

    res.json({
      periodo: { desde: aClaveDia(desde), hasta: aClaveDia(hasta), recortado },
      etapas,
      tasaGlobal,
      tasaGlobalCalculable: tasaGlobal !== null,
      confiableDesde: confiableDesde === null ? null : aClaveDia(confiableDesde),
      // El período es confiable solo si empieza en o después del día en que
      // TODAS las etapas ya registraban. Sin ventana confiable conocida, no se
      // puede afirmar que lo sea.
      periodoConfiable:
        confiableDesde !== null && aClaveDia(desde) >= aClaveDia(confiableDesde),
      fuentesTrafico,
    });
  } catch (err) {
    next(err);
  }
}
