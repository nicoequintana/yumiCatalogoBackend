import { Decimal } from "@prisma/client/runtime/client.js";
import { prisma } from "../lib/prisma.js";
import { totalDeItems } from "../lib/dinero.js";
import {
  ESTADOS_FACTURABLES,
  MAX_ORDENES_HISTORICO,
  aClaveDia,
  parsearPeriodo,
} from "./admin.controller.js";

/** Tope de clientes devueltos en el ranking de facturación. */
const TOP_RANKING = 10;

/**
 * Tope de órdenes que se traen del histórico.
 *
 * Este endpoint es el único de analytics que consulta SIN filtro de fecha, y
 * eso es correcto (ver el bloque "Ventana temporal" más abajo): la recurrencia
 * es una propiedad de por vida. Pero "sin filtro de fecha" no puede significar
 * "sin techo": la consulta crece para siempre y se reduce entera en memoria, así
 * que sin tope el endpoint termina agotando la memoria del contenedor y
 * respondiendo un 500 — un dashboard caído en vez de uno con un número
 * aproximado.
 *
 * 20.000 es holgado para este negocio: son unas 55 órdenes CONFIRMADAS por día
 * sostenidas durante un año entero. Y sigue siendo barato de procesar: la
 * reducción es O(n) sobre filas chicas (id, fecha, cliente e items).
 *
 * Se conservan las órdenes MÁS RECIENTES (`orderBy: createdAt desc`), que es lo
 * que un dashboard de clientes mira. La contrapartida hay que decirla en voz
 * alta: al recortar se pierden las órdenes más viejas, así que un cliente cuya
 * única compra anterior quedó fuera del corte se clasifica como "nuevo" en vez
 * de "recurrente" y su facturación de por vida queda subestimada. Por eso los
 * números pasan a ser un PISO, no la verdad, y la respuesta lo informa en
 * `historico.recortado` — mismo criterio que `periodo.recortado`: si el dato
 * mostrado no es el pedido, se avisa, no se miente en silencio.
 *
 * El valor vive en `admin.controller.js` desde que `resumenVentas` adoptó el
 * mismo patrón: un tope copiado en dos archivos es un tope que en algún
 * momento cambia en uno solo. Se re-exporta acá porque este flujo lo hizo
 * público primero (lo consume su suite de tests).
 */
export { MAX_ORDENES_HISTORICO };

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * GET /api/admin/clientes-resumen — dashboard de clientes del panel admin.
 * Protegida por el `router.use(requireAuth)` de `admin.routes.js`, igual que
 * `/ventas` y `/embudo`.
 *
 * **Identidad del cliente**: `Cliente.dni` es único y ES la identidad — el
 * checkout es de invitado (sin cuentas), así que un DNI repetido actualiza los
 * datos de contacto en vez de crear un cliente nuevo. Por eso el ranking se
 * expone por DNI y no por `id` interno.
 *
 * **Qué cuenta como compra**: los mismos `ESTADOS_FACTURABLES` que el
 * dashboard de ventas (CONFIRMADA en adelante). PENDIENTE y CANCELADA no
 * convierten a alguien en cliente ni suman facturación: si contaran, una
 * orden cancelada inflaría el conteo de clientes y la tasa de recompra.
 *
 * **Ventana temporal — el punto delicado de este endpoint.** Conviven dos
 * horizontes a propósito:
 *  - Las métricas *del período* (total de clientes, ingresos, valor promedio)
 *    miran solo las órdenes del rango pedido.
 *  - La *clasificación* nuevo/recurrente, el ranking y el tiempo entre compras
 *    miran el histórico COMPLETO. Un cliente que compró dos veces es
 *    recurrente aunque solo una de esas compras caiga en la ventana: recortar
 *    el histórico lo etiquetaría como "nuevo" y haría que la tasa de recompra
 *    dependa del zoom del selector de período, que es exactamente la clase de
 *    número que hace desconfiar de un dashboard entero.
 *
 * Ese histórico completo tiene un techo duro de filas: ver
 * `MAX_ORDENES_HISTORICO` y el `historico.recortado` de la respuesta.
 *
 * **Precisión monetaria**: montos en `Decimal`, nunca float (acumular
 * `0.10 * 7` diez veces da `7.000000000000001` en float y `7.00` exacto en
 * Decimal), serializados como string con dos decimales igual que `mapProducto`
 * y `resumenVentas`. El frontend ya espera precios como string.
 *
 * **Estrategia de consulta**: UNA sola query trae las órdenes facturables con
 * su cliente y sus items, y todo se reduce en memoria en O(n). Nada de una
 * query por cliente (N+1) para armar el ranking o contar sus órdenes. No se usa
 * `groupBy` de Prisma porque no sabe agregar la *expresión*
 * `precioUnitario * cantidad`: sumar cada columna por separado daría un
 * resultado matemáticamente incorrecto.
 */
export async function resumenClientes(req, res, next) {
  try {
    const { desde, hasta, hastaInclusive, recortado } = parsearPeriodo(req.query);

    // Sin filtro de fecha a propósito: la recurrencia y la facturación de por
    // vida necesitan el histórico completo (ver el comentario de arriba). El
    // filtro por estado sí va en la base — descarta filas que nunca cuentan.
    //
    // Se pide UNA fila de más que el tope: si vuelve, es la prueba de que había
    // más histórico del que entra, y se descarta antes de calcular. Sin ese +1
    // habría que adivinar si `length === tope` es un corte o una coincidencia.
    const filas = await prisma.orden.findMany({
      where: { estado: { in: ESTADOS_FACTURABLES } },
      orderBy: { createdAt: "desc" },
      take: MAX_ORDENES_HISTORICO + 1,
      select: {
        id: true,
        createdAt: true,
        cliente: { select: { id: true, dni: true, nombre: true } },
        items: { select: { precioUnitario: true, cantidad: true } },
      },
    });

    const historicoRecortado = filas.length > MAX_ORDENES_HISTORICO;
    const ordenes = historicoRecortado ? filas.slice(0, MAX_ORDENES_HISTORICO) : filas;

    // dni -> { dni, nombre, cantidadOrdenes, facturacion, fechas[] }
    const porCliente = new Map();
    // DNIs con al menos una orden facturable dentro del período pedido.
    const clientesDelPeriodo = new Set();

    let ingresosPeriodo = new Decimal(0);

    for (const orden of ordenes) {
      // Defensivo: la relación es obligatoria en el schema, pero una orden sin
      // cliente no debe tumbar el dashboard entero.
      if (!orden.cliente) continue;

      const { dni, nombre } = orden.cliente;
      const total = totalDeItems(orden.items);

      const acumulado = porCliente.get(dni);
      if (acumulado) {
        acumulado.cantidadOrdenes += 1;
        acumulado.facturacion = acumulado.facturacion.plus(total);
        acumulado.fechas.push(orden.createdAt);
      } else {
        porCliente.set(dni, {
          dni,
          nombre,
          cantidadOrdenes: 1,
          facturacion: total,
          fechas: [orden.createdAt],
        });
      }

      const fecha = orden.createdAt.getTime();
      if (fecha >= desde.getTime() && fecha <= hastaInclusive.getTime()) {
        clientesDelPeriodo.add(dni);
        ingresosPeriodo = ingresosPeriodo.plus(total);
      }
    }

    // Nuevo vs. recurrente, entre los clientes que compraron en el período.
    // "Recurrente" = más de una orden facturable de por vida.
    let clientesRecurrentes = 0;
    for (const dni of clientesDelPeriodo) {
      if ((porCliente.get(dni)?.cantidadOrdenes ?? 0) > 1) clientesRecurrentes += 1;
    }
    const totalClientes = clientesDelPeriodo.size;
    const clientesNuevos = totalClientes - clientesRecurrentes;

    // Divisiones protegidas: sin clientes en el período todo da 0, nunca
    // NaN/Infinity (que romperían el formateo en el frontend).
    const valorPromedioPorCliente =
      totalClientes > 0 ? ingresosPeriodo.div(totalClientes).toFixed(2) : "0.00";
    const tasaRecompra =
      totalClientes > 0 ? Math.round((clientesRecurrentes / totalClientes) * 10000) / 10000 : 0;

    const rankingClientes = [...porCliente.values()]
      .sort((a, b) => b.facturacion.comparedTo(a.facturacion))
      .slice(0, TOP_RANKING)
      .map((cliente) => ({
        dni: cliente.dni,
        nombre: cliente.nombre,
        cantidadOrdenes: cliente.cantidadOrdenes,
        facturacion: cliente.facturacion.toFixed(2),
      }));

    /*
     * Tiempo entre compras: promedio de los días entre órdenes CONSECUTIVAS,
     * sobre todos los clientes que compraron 2+ veces.
     *
     * Se promedian los intervalos, no los clientes: un cliente con 5 compras
     * aporta 4 intervalos, y esos 4 datos valen lo mismo que los de cualquier
     * otro. Promediar primero por cliente le daría al que compró dos veces el
     * mismo peso que al que compró veinte.
     *
     * Devuelve `null`, NO 0, cuando nadie repitió. Un 0 se leería como
     * "vuelven a comprar el mismo día", que es lo contrario de la verdad
     * ("todavía no hay recompras que medir"). La UI lo muestra como "sin datos
     * suficientes".
     */
    let intervalos = 0;
    let sumaDias = 0;
    for (const cliente of porCliente.values()) {
      if (cliente.fechas.length < 2) continue;

      // Prisma no garantiza orden sin `orderBy` explícito; sin ordenar acá,
      // dos compras podrían dar un intervalo negativo.
      const fechas = [...cliente.fechas].sort((a, b) => a.getTime() - b.getTime());
      for (let indice = 1; indice < fechas.length; indice += 1) {
        sumaDias += (fechas[indice].getTime() - fechas[indice - 1].getTime()) / MS_POR_DIA;
        intervalos += 1;
      }
    }
    const tiempoEntreCompras =
      intervalos > 0 ? Math.round((sumaDias / intervalos) * 10) / 10 : null;

    res.json({
      periodo: { desde: aClaveDia(desde), hasta: aClaveDia(hasta), recortado },
      // Estado del histórico analizado, en el mismo espíritu que
      // `periodo.recortado`: con `recortado: true` todas las métricas de por
      // vida (recurrentes, ranking, tiempo entre compras) son un piso, porque
      // faltan las órdenes más antiguas.
      historico: {
        ordenesAnalizadas: ordenes.length,
        tope: MAX_ORDENES_HISTORICO,
        recortado: historicoRecortado,
      },
      totalClientes,
      clientesNuevos,
      clientesRecurrentes,
      ingresosPeriodo: ingresosPeriodo.toFixed(2),
      valorPromedioPorCliente,
      tasaRecompra,
      tiempoEntreCompras,
      rankingClientes,
    });
  } catch (err) {
    next(err);
  }
}
