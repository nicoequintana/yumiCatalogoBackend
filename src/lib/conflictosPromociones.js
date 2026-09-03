/**
 * Detección de conflictos entre promociones.
 *
 * LA REGLA QUE MÁS SE MALINTERPRETA: **dos promociones simultáneas no son un
 * conflicto.** El conflicto existe cuando comparten un PRODUCTO durante días
 * que se pisan, y existe **solo sobre ese producto** — no sobre las
 * promociones enteras.
 *
 * Sin esa precisión la alerta saltaría con cualquier par de promos del mismo
 * mes, y una alerta que está siempre prendida es una alerta que nadie mira. Es
 * el mismo criterio con el que `estadoDePrecio` evita marcar `DIFIERE` como un
 * problema: un aviso que no distingue deja de informar.
 *
 * ES UNA FUNCIÓN PURA, sin Prisma: el controller arma la forma que entra acá y
 * esto solo decide. Así el caso del §34 —el que más cuesta explicar— se puede
 * afirmar en un test sin base de datos de por medio.
 *
 * NO resuelve nada. Quién gana lo decide una persona (§35): elegir
 * automáticamente el mayor descuento, o el último, sería tomar por el admin una
 * decisión de plata que el pedido reserva explícitamente para él.
 */

/**
 * ¿Dos períodos comparten al menos un día?
 *
 * Los dos extremos son INCLUSIVOS, igual que en el resto del módulo: dos
 * períodos que se tocan en un solo día se pisan ese día.
 *
 * Compara strings `"YYYY-MM-DD"` directamente — el formato ISO ordena
 * lexicográficamente igual que cronológicamente, así que no hace falta
 * construir ningún `Date` y la zona horaria no puede entrar.
 */
export function periodosSeSuperponen(a, b) {
  return a.desde <= b.hasta && b.desde <= a.hasta;
}

/** ¿Alguno de los períodos de A se pisa con alguno de los de B? */
function algunPeriodoSePisa(periodosA, periodosB) {
  return periodosA.some((a) => periodosB.some((b) => periodosSeSuperponen(a, b)));
}

/**
 * Los conflictos vigentes, uno por PRODUCTO.
 *
 * Un conflicto es del producto y no del par de promociones: con tres promos
 * sobre el mismo producto sale UN conflicto con las tres, no tres pares. Si no,
 * el admin resolvería lo mismo varias veces.
 *
 * @param {Array<{id: number, nombre: string, items: Array<{productId: number, porcentaje: number, habilitado: boolean, nombreProducto: string}>, periodos: Array<{desde: string, hasta: string}>}>} promociones
 * @returns {Array<{productId: number, nombreProducto: string, promociones: Array<{id: number, nombre: string, porcentaje: number}>, predominaId: number}>}
 */
export function detectarConflictos(promociones) {
  // Una promoción SIN programar no se aplica a nadie, así que no puede pisarle
  // el precio a nada: marcarla sería una alerta sobre algo que no está pasando.
  const enJuego = (promociones ?? []).filter((p) => (p.periodos?.length ?? 0) > 0);

  // Qué promociones alcanzan a cada producto. `habilitado: false` queda afuera:
  // es una decisión de conflicto YA tomada, y si siguiera figurando, resolver
  // un conflicto no tendría ningún efecto visible.
  const porProducto = new Map();
  for (const promocion of enJuego) {
    for (const item of promocion.items ?? []) {
      if (!item.habilitado) continue;
      const lista = porProducto.get(item.productId) ?? [];
      lista.push({ promocion, item });
      porProducto.set(item.productId, lista);
    }
  }

  const conflictos = [];
  for (const [productId, candidatos] of porProducto) {
    if (candidatos.length < 2) continue;

    // Solo entran los que efectivamente se pisan en el tiempo con algún otro.
    // Dos promos sobre el mismo producto en meses distintos conviven bien.
    const enConflicto = candidatos.filter((candidato) =>
      candidatos.some(
        (otro) =>
          otro !== candidato &&
          algunPeriodoSePisa(candidato.promocion.periodos, otro.promocion.periodos),
      ),
    );
    if (enConflicto.length < 2) continue;

    // El que PREDOMINA es el del descuento menor, que es exactamente lo que
    // `resolverDescuentos` está aplicando mientras nadie resuelva. La alerta
    // tiene que decir la verdad de lo que el catálogo muestra AHORA.
    const predomina = enConflicto.reduce((mejor, actual) =>
      actual.item.porcentaje < mejor.item.porcentaje ? actual : mejor,
    );

    conflictos.push({
      productId,
      nombreProducto: enConflicto[0].item.nombreProducto,
      promociones: enConflicto.map(({ promocion, item }) => ({
        id: promocion.id,
        nombre: promocion.nombre,
        porcentaje: item.porcentaje,
      })),
      predominaId: predomina.promocion.id,
    });
  }

  // Orden estable: sin esto, dos consultas seguidas pueden devolver la lista en
  // distinto orden y la pantalla parece cambiar sola.
  return conflictos.sort((a, b) => a.productId - b.productId);
}
