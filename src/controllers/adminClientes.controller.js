import { Decimal } from "@prisma/client/runtime/client.js";
import { prisma } from "../lib/prisma.js";
import { ESTADOS_FACTURABLES, aClaveDia, parsearPeriodo } from "./admin.controller.js";

/** Tope de clientes devueltos en el ranking de facturación. */
const TOP_RANKING = 10;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Total facturado de una orden desde los snapshots de sus items
 * (`precioUnitario * cantidad`), acumulado en `Decimal`.
 *
 * `precioUnitario` llega como `Decimal` desde Prisma, pero se normaliza igual:
 * en tests o mocks puede venir como string o number, y `Decimal` acepta las
 * tres formas sin perder precisión.
 */
function totalDeOrden(orden) {
  return orden.items.reduce(
    (acumulado, item) => acumulado.plus(new Decimal(item.precioUnitario).mul(item.cantidad)),
    new Decimal(0),
  );
}

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
    const ordenes = await prisma.orden.findMany({
      where: { estado: { in: ESTADOS_FACTURABLES } },
      select: {
        id: true,
        createdAt: true,
        cliente: { select: { id: true, dni: true, nombre: true } },
        items: { select: { precioUnitario: true, cantidad: true } },
      },
    });

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
      const total = totalDeOrden(orden);

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
