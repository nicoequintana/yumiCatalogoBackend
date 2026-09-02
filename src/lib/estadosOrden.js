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
export const ESTADOS_NO_TERMINALES = ["PENDIENTE", "EN_PREPARACION"];

/** Estados desde los que una orden ya no se mueve más. */
export const ESTADOS_TERMINALES = ["ENTREGADA", "CANCELADA"];

/** Los 4 estados del modelo, en orden de flujo. */
export const ESTADOS_ORDEN = [...ESTADOS_NO_TERMINALES, ...ESTADOS_TERMINALES];

/**
 * Estados que significan "esta mercadería ya salió del depósito", y por lo
 * tanto los que TOMAN el stock.
 *
 * ENTREGADA está incluida a propósito. El sistema no tiene máquina de estados
 * (cualquier estado puede ir a cualquier otro, decisión ya cerrada), así que
 * mandar una orden de PENDIENTE directo a ENTREGADA es un camino real — el
 * atajo natural de quien entrega en el día. Con el disparador atado a un solo
 * estado, ese camino escribía la etiqueta y NO descontaba nada, mientras la
 * orden sí contaba como venta en las métricas. Sin error y sin aviso.
 *
 * Que ocurra exactamente una vez no lo garantiza esta lista sino
 * `Orden.stockDescontado`, que es el árbitro real (ver el comentario de la
 * columna en `schema.prisma`).
 *
 * Hoy coincide valor por valor con `ESTADOS_FACTURABLES` de
 * `admin.controller.js`, y eso es correcto: las dos listas quieren decir "la
 * mercadería salió". Se mantienen separadas porque responden preguntas
 * distintas —una es de inventario, la otra de contabilidad— y podrían
 * divergir legítimamente. Colapsarlas ataría una a la otra por accidente.
 */
export const ESTADOS_CON_STOCK_TOMADO = ["EN_PREPARACION", "ENTREGADA"];

/**
 * Etiquetas legibles de cada estado, para el texto que ve una persona.
 *
 * Desde el 02/09/2026 este diccionario es LA ÚNICA copia: el frontend dejó de
 * tener la suya (`constants/ordenes.js` conserva solo los estilos, que son
 * presentación). Las etiquetas viajan en las respuestas — `estadoEtiqueta` en
 * cada orden, `etiqueta` en el desglose de ventas, y la lista completa por
 * `GET /ordenes/estados` (ver `listaDeEstados`). Los mails las consumen igual
 * que siempre. Agregar un estado se toca en UN solo lugar: acá.
 */
export const ETIQUETA_ESTADO = {
  PENDIENTE: "Pendiente",
  EN_PREPARACION: "En preparación",
  ENTREGADA: "Entregada",
  CANCELADA: "Cancelada",
};

/**
 * Etiqueta legible de un estado, con la clave cruda como respaldo.
 *
 * El respaldo importa: un estado que este módulo no conozca (una migración a
 * medio aplicar, un dato viejo) tiene que salir como su clave — feo pero
 * legible — nunca como `undefined` en la pantalla del admin.
 */
export function etiquetaDeEstado(estado) {
  return ETIQUETA_ESTADO[estado] ?? estado;
}

/**
 * Los cuatro estados en orden de flujo, con su etiqueta y si son terminales:
 * la forma que consumen el select de estados del panel y las tarjetas de
 * AdminOperacion.
 *
 * Devuelve objetos NUEVOS en cada llamada: el resultado viaja a serialización
 * y a pantallas que podrían mutarlo, y un llamador descuidado no puede
 * envenenar la fuente para el resto del proceso.
 */
export function listaDeEstados() {
  return ESTADOS_ORDEN.map((valor) => ({
    valor,
    etiqueta: etiquetaDeEstado(valor),
    terminal: ESTADOS_TERMINALES.includes(valor),
  }));
}
