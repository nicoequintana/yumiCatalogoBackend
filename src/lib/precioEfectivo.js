import { Decimal } from "@prisma/client/runtime/client.js";
import { redondearAEntero } from "./precios.js";
import { claveDiaArgentino, inicioDelDiaArgentino } from "./horarioArgentino.js";

/**
 * El precio que efectivamente paga un cliente cuando hay una promoción activa.
 *
 * REGLA QUE SOSTIENE TODO ESTE MÓDULO: **el precio promocional se DERIVA en la
 * lectura, nunca se escribe.** `Product.precio` es una columna persistida que
 * solo tocan el alta y `POST /products/precios-masivo`; escribirla desde acá
 * rompería el flujo `Difiere → Aplicar` —el precio publicado dejaría de ser el
 * que alguien decidió publicar— y el descuento sería irreversible al terminar
 * la promo.
 *
 * El redondeo NO se inventa acá: sale de `redondearAEntero` de `lib/precios.js`,
 * que es la única casa del redondeo del sistema (`ROUND_HALF_UP` al peso). Dos
 * definiciones de redondeo darían precios distintos según por dónde se entre.
 */

/**
 * El rango de descuento que el negocio acepta.
 *
 * El piso en 5 % no es técnico: por debajo el cliente no percibe la diferencia y
 * el descuento solo regala margen. El techo en 50 % es la barrera contra el
 * error de tipeo —un 500 % tipeado de más— en un campo que cambia lo que se
 * cobra.
 */
export const PORCENTAJE_MIN = 5;
export const PORCENTAJE_MAX = 50;

/**
 * Un porcentaje válido es un ENTERO dentro del rango.
 *
 * Entero y no decimal por lo mismo que los montos: un `12,5 %` sobre un precio
 * entero produce fracciones que después hay que redondear en algún lado, y ese
 * "algún lado" es donde aparecen las diferencias de un peso que nadie sabe
 * explicar.
 */
export function esPorcentajeValido(valor) {
  return Number.isInteger(valor) && valor >= PORCENTAJE_MIN && valor <= PORCENTAJE_MAX;
}

/**
 * Normaliza un precio a `Decimal`. `null` si falta o no se puede leer.
 *
 * Acepta cero: es un precio raro pero válido, y es DISTINTO de "no se puede
 * calcular". Mismo criterio que `costoDeItem` en `dinero.js`, donde confundir
 * las dos cosas inflaba la ganancia sin que nada lo delatara.
 */
function aDecimal(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  try {
    // Los objetos se pasan por `toString()` antes de construir el `Decimal`:
    // decimal.js acepta number, string y Decimal, pero no un objeto
    // cualquiera. Prisma devuelve su propio wrapper de Decimal, cuyo
    // `toString()` da el string numérico exacto — sin este paso, un precio
    // leído de la base con un cliente de otra versión podría no construirse.
    const crudo = typeof valor === "object" ? valor.toString() : valor;
    const decimal = new Decimal(crudo);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

/**
 * `precio` con `porcentaje` de descuento, redondeado al peso.
 *
 * Devuelve un `Decimal` —no un number— porque toda la aritmética de plata del
 * proyecto va en `Decimal`, y porque en float el redondeo de un caso al medio
 * peso dependería del error de representación binaria en vez de la regla.
 *
 * **`null` ante cualquier entrada inválida, NUNCA el precio de lista.** Devolver
 * el precio sin tocar escondería el error: la card mostraría un descuento que
 * no descuenta, y nadie se enteraría hasta ver la facturación.
 *
 * @param {Decimal|string|number} precio
 * @param {number} porcentaje - entero entre PORCENTAJE_MIN y PORCENTAJE_MAX
 * @returns {Decimal|null}
 */
export function precioConDescuento(precio, porcentaje) {
  if (!esPorcentajeValido(porcentaje)) return null;

  const base = aDecimal(precio);
  if (base === null) return null;

  // Se multiplica ANTES de dividir: `precio × (100 − pct) / 100` mantiene la
  // precisión que `precio × (1 − pct/100)` perdería en el cociente intermedio.
  return redondearAEntero(base.mul(100 - porcentaje).div(100));
}

/**
 * El `where` de una promoción que se está aplicando AHORA.
 *
 * Extraída de `resolverDescuentos` para que el filtro `?conDescuento=1` del
 * listado no la copie: sería la TERCERA copia de la regla de vigencia, y una
 * regla duplicada se desincroniza sin que nada falle — el listado mostraría un
 * producto como "en oferta" y el precio saldría de lista, o al revés.
 *
 * Una promoción se aplica por DOS caminos y el `OR` cubre los dos:
 *
 * - **programación individual**: habilitada y en fecha;
 * - **dentro de una campaña**: la campaña HABILITADA y en fecha. De ahí sale
 *   que apagar una campaña apague todas sus promociones de una.
 *
 * La frontera de fin es **la medianoche de HOY**, no el instante: `hasta` guarda
 * una medianoche argentina, así que `hasta >= medianoche de hoy` significa "su
 * último día es hoy o más adelante". Comparar contra `ahora` apagaría toda promo
 * que termine hoy, a cualquier hora del día.
 *
 * @param {Date} [ahora]
 */
export function condicionPromocionVigente(ahora = new Date()) {
  const medianocheDeHoy = inicioDelDiaArgentino(claveDiaArgentino(ahora));
  const enFecha = { desde: { lte: ahora }, hasta: { gte: medianocheDeHoy } };

  return {
    activa: true,
    OR: [
      { programaciones: { some: { habilitada: true, ...enFecha } } },
      { campanias: { some: { campania: { estado: "HABILITADA", ...enFecha } } } },
    ],
  };
}

/**
 * El filtro de RELACIÓN para `Product.itemsPromocion`: "este producto tiene un
 * descuento vigente".
 *
 * ⚠️ Filtro por relación y NO una lista de ids. Resolver los ids primero y
 * pasarlos como `id: { in: [...] }` revienta el límite de 2.100 parámetros de
 * SQL Server en cuanto haya muchos productos rebajados, y sale como un 500
 * opaco en el listado público.
 *
 * @param {Date} [ahora]
 */
export function condicionProductoConDescuento(ahora = new Date()) {
  return { some: { habilitado: true, promocion: condicionPromocionVigente(ahora) } };
}

/**
 * Qué descuento le corresponde a cada uno de estos productos, AHORA.
 *
 * **UNA consulta por request, no una por producto.** Esto corre en cada listado
 * del catálogo —doce productos por página— y en cada ficha con sus
 * relacionados: resolver de a uno sería un N+1 en la pantalla que más se mira.
 *
 * CONFLICTO SIN RESOLVER: si dos promociones alcanzan al mismo producto, **gana
 * el porcentaje MENOR**. El catálogo tiene que mostrar algo, y el menor nunca
 * regala más de lo previsto. La alerta del panel es la que empuja a decidir;
 * mientras tanto el sitio es conservador.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {number[]} productIds
 * @param {Date} [ahora]
 * @returns {Promise<Map<number, {porcentaje: number, promocionId: number, promocionNombre: string}>>}
 */
export async function resolverDescuentos(prisma, productIds, ahora = new Date()) {
  const mapa = new Map();
  // Sin ids no hay nada que resolver, y una consulta con `in: []` es una
  // consulta al pedo contra la base en cada página vacía.
  if (!productIds?.length) return mapa;

  const items = await prisma.promocionItem.findMany({
    where: {
      productId: { in: productIds },
      // `habilitado: false` es la decisión persistida de un conflicto perdido:
      // no puede volver por la puerta de atrás en la resolución del precio.
      habilitado: true,
      promocion: condicionPromocionVigente(ahora),
    },
    select: {
      productId: true,
      porcentaje: true,
      promocion: { select: { id: true, nombre: true } },
    },
  });

  for (const item of items) {
    // Un porcentaje fuera de rango se DESCARTA. La validación vive en la
    // entrada, pero un dato viejo o tocado a mano en la base no puede producir
    // un precio absurdo en la vidriera.
    if (!esPorcentajeValido(item.porcentaje)) continue;

    const actual = mapa.get(item.productId);
    if (actual && actual.porcentaje <= item.porcentaje) continue;

    mapa.set(item.productId, {
      porcentaje: item.porcentaje,
      promocionId: item.promocion.id,
      promocionNombre: item.promocion.nombre,
    });
  }

  return mapa;
}
