import { prisma } from "../lib/prisma.js";
import { totalDeItems } from "../lib/dinero.js";
import { aClaveDia, parsearPeriodo } from "./admin.controller.js";
// Fuente única de los estados de `Orden` (ver lib/estadosOrden.js). Acá el
// tablero de estancamiento se limita a los no terminales, y `ESTADOS_ORDEN`
// fija las claves de la respuesta.
import { ESTADOS_NO_TERMINALES, ESTADOS_ORDEN, listaDeEstados, etiquetaDeEstado } from "../lib/estadosOrden.js";

/**
 * Días sin cambios a partir de los cuales una orden se considera estancada.
 *
 * Tres días es el corte porque cubre un fin de semana completo: una orden que
 * entró un viernes y sigue igual el lunes todavía es operación normal, pero
 * pasado eso ya nadie la tocó en un ciclo hábil entero.
 */
const UMBRAL_ESTANCAMIENTO_DIAS = 3;

/**
 * Tope de filas de la tabla de estancadas. Es una lista de trabajo para
 * destrabar a mano, no un export: más de 20 filas deja de ser accionable.
 * El conteo total viaja aparte, así que un recorte nunca esconde el tamaño
 * real del problema.
 */
const TOP_ESTANCADAS = 20;

/** Tope de filas de las tablas de stock (quiebres con demanda y stock bajo). */
const TOP_STOCK = 20;

/**
 * Umbral de stock bajo. NO es un número nuevo: es el mismo corte que ya usa el
 * badge "Últimos N" del frontend (`ProductCard.jsx` y `ProductoDetalle.jsx`,
 * ambos con `stock > 0 && stock <= 3`). Se mantiene sincronizado a propósito
 * para que el admin y el catálogo público consideren "por agotarse" a los
 * mismos productos — si acá fuera otro número, el dashboard avisaría de un
 * riesgo que la tienda no está comunicando, o al revés.
 */
const STOCK_BAJO_MAXIMO = 3;

const MS_POR_DIA = 24 * 60 * 60 * 1000;

/**
 * Días enteros transcurridos desde `fecha` hasta `ahora`, hacia abajo.
 *
 * IMPORTANTE — qué mide realmente este número: el modelo `Orden` solo tiene
 * `createdAt` y `updatedAt`, sin historial por estado. No existe registro de
 * cuándo la orden entró al estado en el que está hoy. Así que esto es tiempo
 * desde el ÚLTIMO cambio de cualquier tipo (incluida una edición de notas),
 * no tiempo pasado en el estado actual. Toda la nomenclatura del endpoint
 * ("diasSinCambios", "antiguedadPromedio" sin cambios) refleja eso y evita a
 * propósito la etiqueta "tiempo en este estado", que sería falsa.
 */
function diasDesde(fecha, ahora) {
  return Math.floor((ahora.getTime() - new Date(fecha).getTime()) / MS_POR_DIA);
}

/**
 * GET /api/admin/operacion — tablero operativo del panel admin. Protegida por
 * el `router.use(requireAuth)` de `admin.routes.js`, igual que `/ventas` y
 * `/embudo`, y con el mismo parseo de período (`parsearPeriodo`, reutilizado
 * de `admin.controller.js` en vez de duplicado).
 *
 * A diferencia de `/ventas` (que mide resultado) este endpoint mide **trabajo
 * pendiente**: qué órdenes están frenadas y qué demanda se está perdiendo por
 * falta de stock. La métrica central es `ordenesEstancadas` — una orden quieta
 * es plata comprometida que nadie está moviendo.
 *
 * **Limitación estructural del dato de tiempo** (ver `diasDesde`): sin
 * historial por estado, lo único derivable de `updatedAt` es el tiempo desde
 * el último cambio, no el tiempo en el estado actual. Se reporta como tal, con
 * ese nombre, en API y en UI. Preferimos un número honesto y menos preciso a
 * una métrica que aparenta exactitud que no tiene.
 *
 * **Estrategia de consulta**: todo agregado en la base y en paralelo — un
 * `groupBy` para el conteo por estado, un `groupBy` sobre `EventoTrafico`
 * (que aprovecha el índice `[tipo, createdAt]`) para las vistas del período, y
 * `findMany` acotados para las listas. Cero N+1: los productos sin stock se
 * cruzan con sus vistas en memoria con un `Map`, no con una query por producto.
 */
export async function resumenOperacion(req, res, next) {
  try {
    const { desde, hasta, hastaInclusive, recortado } = parsearPeriodo(req.query);

    const ahora = new Date();
    const corteEstancamiento = new Date(ahora.getTime() - UMBRAL_ESTANCAMIENTO_DIAS * MS_POR_DIA);

    const [
      conteosPorEstado,
      estancadas,
      totalEstancadas,
      noTerminales,
      productosSinStock,
      vistasPorProducto,
      productosStockBajo,
    ] = await Promise.all([
      // Conteo por estado del período (por createdAt), agregado en la base.
      prisma.orden.groupBy({
        by: ["estado"],
        where: { createdAt: { gte: desde, lte: hastaInclusive } },
        _count: { _all: true },
      }),

      // Lista de estancadas. Sin filtro de período a propósito: una orden
      // frenada desde hace meses sigue siendo trabajo pendiente HOY, y
      // esconderla porque cayó fuera de la ventana elegida sería justo el
      // caso más grave el que no se ve.
      prisma.orden.findMany({
        where: {
          estado: { in: ESTADOS_NO_TERMINALES },
          updatedAt: { lt: corteEstancamiento },
        },
        orderBy: { updatedAt: "asc" },
        take: TOP_ESTANCADAS,
        select: {
          id: true,
          estado: true,
          updatedAt: true,
          cliente: { select: { nombre: true } },
          items: { select: { precioUnitario: true, cantidad: true } },
        },
      }),
      prisma.orden.count({
        where: {
          estado: { in: ESTADOS_NO_TERMINALES },
          updatedAt: { lt: corteEstancamiento },
        },
      }),

      // Todas las no terminales (sin filtro de updatedAt) para el promedio de
      // antigüedad: el promedio tiene que incluir también las que están al día,
      // si no mediría solo las estancadas y siempre daría un número alarmante.
      prisma.orden.findMany({
        where: { estado: { in: ESTADOS_NO_TERMINALES } },
        select: { id: true, estado: true, updatedAt: true },
      }),

      prisma.product.findMany({
        where: { stock: { lte: 0 } },
        select: { id: true, nombre: true, stock: true },
      }),
      prisma.eventoTrafico.groupBy({
        by: ["productId"],
        where: {
          tipo: "VISTA_PRODUCTO",
          createdAt: { gte: desde, lte: hastaInclusive },
        },
        _count: { _all: true },
      }),

      prisma.product.findMany({
        where: { stock: { gt: 0, lte: STOCK_BAJO_MAXIMO } },
        orderBy: { stock: "asc" },
        take: TOP_STOCK,
        select: { id: true, nombre: true, stock: true },
      }),
    ]);

    // Los 4 estados siempre presentes, en cero si no hubo órdenes: la UI no
    // tiene que distinguir entre "cero" y "no vino en la respuesta".
    const ordenesPorEstado = Object.fromEntries(ESTADOS_ORDEN.map((estado) => [estado, 0]));
    for (const fila of conteosPorEstado) {
      if (fila.estado in ordenesPorEstado) {
        ordenesPorEstado[fila.estado] = fila._count?._all ?? 0;
      }
    }

    // Más estancada primero. Ya viene ordenado por `updatedAt: asc` de la base
    // (updatedAt más viejo = más días sin cambios), el sort solo lo hace
    // explícito sobre el valor que efectivamente se muestra.
    const listaEstancadas = estancadas
      .map((orden) => ({
        id: orden.id,
        estado: orden.estado,
        // Mismo criterio que `mapOrden`: la etiqueta viaja con el dato para que
        // el badge del frontend no necesite su propio diccionario.
        estadoEtiqueta: etiquetaDeEstado(orden.estado),
        diasSinCambios: diasDesde(orden.updatedAt, ahora),
        clienteNombre: orden.cliente?.nombre ?? "Sin cliente",
        total: totalDeItems(orden.items).toFixed(0),
      }))
      .sort((a, b) => b.diasSinCambios - a.diasSinCambios);

    // Promedio de días sin cambios por estado no terminal. División protegida:
    // un estado sin órdenes da 0, nunca NaN (que rompería el formateo en la UI).
    const acumuladoPorEstado = new Map(
      ESTADOS_NO_TERMINALES.map((estado) => [estado, { dias: 0, cantidad: 0 }]),
    );
    for (const orden of noTerminales) {
      const acumulado = acumuladoPorEstado.get(orden.estado);
      if (!acumulado) continue;
      acumulado.dias += diasDesde(orden.updatedAt, ahora);
      acumulado.cantidad += 1;
    }
    const antiguedadPromedio = Object.fromEntries(
      ESTADOS_NO_TERMINALES.map((estado) => {
        const { dias, cantidad } = acumuladoPorEstado.get(estado);
        return [estado, cantidad > 0 ? Math.round((dias / cantidad) * 10) / 10 : 0];
      }),
    );

    // Quiebres CON demanda: un producto agotado que además nadie miró en el
    // período no es accionable — no se perdió ninguna venta por reponerlo
    // tarde. Solo entran los que tuvieron vistas, ordenados por cuánta
    // demanda quedó sin capturar.
    const vistasPorId = new Map(
      vistasPorProducto
        .filter((fila) => fila.productId !== null && fila.productId !== undefined)
        .map((fila) => [fila.productId, fila._count?._all ?? 0]),
    );
    const quiebresConDemanda = productosSinStock
      .map((producto) => ({
        productId: producto.id,
        nombre: producto.nombre,
        vistas: vistasPorId.get(producto.id) ?? 0,
        stock: producto.stock,
      }))
      .filter((fila) => fila.vistas > 0)
      .sort((a, b) => b.vistas - a.vistas)
      .slice(0, TOP_STOCK);

    const stockBajo = productosStockBajo.map((producto) => ({
      productId: producto.id,
      nombre: producto.nombre,
      stock: producto.stock,
    }));

    res.json({
      periodo: { desde: aClaveDia(desde), hasta: aClaveDia(hasta), recortado },
      umbralEstancamientoDias: UMBRAL_ESTANCAMIENTO_DIAS,
      // La lista con etiquetas y bandera terminal viaja EN la respuesta: las
      // tarjetas "Órdenes por estado" se pintan iterando esto, así la pantalla
      // no necesita su propia copia del diccionario ni de qué estados
      // "todavía requieren trabajo".
      estados: listaDeEstados(),
      stockBajoMaximo: STOCK_BAJO_MAXIMO,
      ordenesPorEstado,
      ordenesEstancadas: {
        total: totalEstancadas,
        lista: listaEstancadas,
      },
      antiguedadPromedio,
      quiebresConDemanda,
      stockBajo,
    });
  } catch (err) {
    next(err);
  }
}
