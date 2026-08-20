/**
 * Fuente única de verdad de los estados de una `Orden`.
 *
 * La lista canónica vive en `prisma/schema.prisma` (`Orden.estado` es un
 * `VarChar(20)`, no un enum de base — SQL Server vía Prisma no tiene enums
 * nativos, así que el schema solo puede documentarlos en un comentario). Ese
 * comentario no compila nada: lo que efectivamente valida es este módulo, y
 * por eso tiene que estar en un solo lugar. Antes la lista estaba repetida en
 * `ordenes.controller.js` y en `adminOperacion.controller.js`, con el riesgo
 * clásico: agregar un estado nuevo en uno y que el otro lo cuente como cero
 * sin fallar nunca.
 *
 * NO confundir con `ESTADOS_FACTURABLES` (`admin.controller.js`): ese es un
 * SUBCONJUNTO deliberado — los estados desde los que una orden ya cuenta como
 * venta — y vive con la lógica de analytics que lo justifica, no acá.
 */

/**
 * Estados en los que una orden todavía requiere trabajo de alguien. Son el
 * complemento exacto de los terminales (ENTREGADA / CANCELADA): una orden
 * terminal no puede estar "frenada", ya terminó su recorrido.
 */
export const ESTADOS_NO_TERMINALES = ["PENDIENTE", "CONFIRMADA", "EN_PREPARACION"];

/** Estados desde los que una orden ya no se mueve más. */
export const ESTADOS_TERMINALES = ["ENTREGADA", "CANCELADA"];

/** Los 5 estados del modelo, en orden de flujo. */
export const ESTADOS_ORDEN = [...ESTADOS_NO_TERMINALES, ...ESTADOS_TERMINALES];
