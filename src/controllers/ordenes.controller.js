import { Decimal } from "@prisma/client/runtime/client.js";
import { prisma } from "../lib/prisma.js";
import { normalizarDni, esDniValido } from "../lib/dni.js";
import { subtotalDeItem } from "../lib/dinero.js";
import { precioConDescuento, resolverDescuentos } from "../lib/precioEfectivo.js";
import { generarExportacionSolicitados } from "../lib/exportarProductosSolicitados.js";
import {
  MAX_ORDENES_HISTORICO,
  aClaveDia,
  hayPeriodoPedido,
  parsearPeriodo,
} from "./admin.controller.js";
import { logAudit } from "../lib/logAudit.js";
import { logEvento, headersDeEvento } from "../lib/logEvento.js";
import { ESTADOS_ORDEN, ESTADOS_CON_STOCK_TOMADO, listaDeEstados } from "../lib/estadosOrden.js";
import { httpError } from "../lib/httpError.js";
import { escaparLike } from "../lib/escaparLike.js";
import { parsearPaginacion } from "../lib/paginacion.js";
import { esEmailValido } from "../lib/emailValido.js";
import { exigirTextoAcotado } from "../lib/cuentaClienteReglas.js";
import {
  DETALLE_ORDEN_CUENTA_INCLUDE,
  DETALLE_ORDEN_INCLUDE,
  LISTADO_ORDEN_INCLUDE,
  mapOrden,
  mapOrdenCuenta,
  mapOrdenListado,
} from "./ordenes.mapper.js";
import { notificarCambioEstado, notificarOrdenCreada } from "../services/notificacionesOrden.service.js";

const MAX_INTENTOS_DNI = 5;

// Topes anti-abuso del checkout público (POST /ordenes no requiere auth, solo
// rate limit por IP): sin ellos un body armado a mano podía crear una orden
// con miles de items o cantidades absurdas. Exportados para los tests.
export const MAX_ITEMS_POR_ORDEN = 100;
export const MAX_CANTIDAD_POR_ITEM = 999;

/**
 * Valida los campos requeridos del body de creación de orden (checkout de
 * invitado): dni/nombre/telefono/email/items no vacíos. `notas` es el único
 * opcional. Manual validation, sin Zod/Joi — sigue el mismo estilo que
 * `products.controller.js`'s `validarCamposBase`.
 *
 * El email es obligatorio desde que el checkout manda comprobante por correo:
 * sin él, la orden no es notificable ni al crearse ni al cambiar de estado.
 * La columna `Cliente.email` sigue siendo nullable — hay clientes históricos
 * anteriores a esta regla —, así que la obligatoriedad la impone la API.
 */
function validarCamposBase({ dni, nombre, telefono, email, items }) {
  if (typeof dni !== "string" || dni.trim() === "") {
    throw httpError(400, "El DNI es obligatorio.");
  }
  if (typeof nombre !== "string" || nombre.trim() === "") {
    throw httpError(400, "El nombre es obligatorio.");
  }
  if (typeof telefono !== "string" || telefono.trim() === "") {
    throw httpError(400, "El teléfono es obligatorio.");
  }
  if (typeof email !== "string" || email.trim() === "") {
    throw httpError(400, "El email es obligatorio.");
  }
  if (!esEmailValido(email)) {
    throw httpError(400, "El email no tiene un formato válido.");
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, "Debe incluir al menos un producto en la orden.");
  }
  if (items.length > MAX_ITEMS_POR_ORDEN) {
    throw httpError(400, `Una orden no puede tener más de ${MAX_ITEMS_POR_ORDEN} items.`);
  }
}

/**
 * Valida la forma de cada item del body ANTES de tocar la DB: productId y
 * cantidad deben ser enteros positivos. No valida existencia/disponibilidad
 * del producto acá (eso requiere DB, se hace después en `validarProductos`).
 */
function validarFormaItems(items) {
  for (const item of items) {
    const productId = Number(item?.productId);
    const cantidad = Number(item?.cantidad);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw httpError(400, "Cada item debe tener un productId válido.");
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw httpError(400, "Cada item debe tener una cantidad entera mayor a 0.");
    }
    if (cantidad > MAX_CANTIDAD_POR_ITEM) {
      throw httpError(400, `Cada item admite una cantidad máxima de ${MAX_CANTIDAD_POR_ITEM} unidades.`);
    }
  }
}

/**
 * Busca en la DB todos los productos referenciados por los items y valida
 * que: (a) todos existan, (b) estén visibles en el catálogo, (c) no estén
 * agotados. Si CUALQUIER item falla cualquiera de estas condiciones, rechaza
 * el pedido COMPLETO (no hay orden parcial) — por eso esta validación
 * corre antes de abrir la transacción de escritura.
 *
 * Devuelve un snapshot (nombre/precio) de cada producto en el momento exacto
 * de esta llamada — ese snapshot es lo que se persiste en ItemOrden y NUNCA
 * se vuelve a calcular a partir del Product en vivo (invariante permanente:
 * una orden refleja lo que el cliente vio al comprar, aunque el producto
 * después cambie de precio/nombre o se elimine).
 */
async function validarYSnapshotearProductos(items) {
  const ids = items.map((item) => Number(item.productId));
  const productos = await prisma.product.findMany({ where: { id: { in: ids } } });
  const porId = new Map(productos.map((p) => [p.id, p]));

  // Los descuentos vigentes AHORA, en UNA consulta para toda la orden. Se
  // resuelven acá y no en el frontend por el mismo motivo por el que el precio
  // tampoco viene del cliente: es lo que se va a cobrar.
  const descuentos = await resolverDescuentos(prisma, ids);

  const itemsConSnapshot = [];
  for (const item of items) {
    const productId = Number(item.productId);
    const cantidad = Number(item.cantidad);
    const producto = porId.get(productId);

    if (!producto) {
      throw httpError(400, `El producto ${productId} no existe.`);
    }
    if (!producto.visibleEnCatalogo) {
      throw httpError(400, `El producto "${producto.nombre}" ya no está disponible.`);
    }
    if (producto.stock <= 0) {
      throw httpError(400, `El producto "${producto.nombre}" está agotado.`);
    }

    // El precio que se cobra: el efectivo si hay promoción vigente, el de lista
    // si no. `precioConDescuento` devuelve `null` ante un porcentaje inválido,
    // y ese null cae al de lista — nunca se cobra un precio que el sistema no
    // pudo calcular.
    const descuento = descuentos.get(productId) ?? null;
    const efectivo = descuento ? precioConDescuento(producto.precio, descuento.porcentaje) : null;
    const huboDescuento = efectivo !== null;

    itemsConSnapshot.push({
      productId,
      nombreProducto: producto.nombre,
      // Lo que el cliente PAGÓ. Guardar acá el de lista facturaría de más una
      // venta que se cobró de menos, y la orden se crearía igual: es el error
      // más caro que esta feature puede cometer y no falla en ningún lado.
      precioUnitario: (huboDescuento ? efectivo : producto.precio).toString(),
      // Lo que valía SIN promoción, y el porcentaje. Existen para poder
      // contestar después "¿cuánta plata regalé en la campaña?": el precio de
      // lista puede cambiar en cualquier momento, así que si no queda acá no
      // queda en ningún lado.
      //
      // `null` significa "esta línea no tuvo descuento", NUNCA "descuento
      // cero" — que además no puede existir, porque el mínimo es 5 %.
      precioListaUnitario: huboDescuento ? producto.precio.toString() : null,
      descuentoPorcentaje: huboDescuento ? descuento.porcentaje : null,
      // Foto del COSTO, por el mismo motivo que la del precio: sin ella, el
      // margen de esta venta se calcularía más adelante contra el
      // `Product.costo` vigente en ESE momento, y cada aumento de un proveedor
      // reescribiría las ganancias de todos los meses anteriores.
      //
      // `null` cuando el producto todavía no tiene costo cargado. Significa "no
      // se puede calcular el margen de esta línea", NUNCA "margen 0", y quien
      // lo consuma tiene que distinguir los dos casos.
      costoUnitario: producto.costo?.toString() ?? null,
      cantidad,
    });
  }

  return itemsConSnapshot;
}

/**
 * Upsert de Cliente por dni normalizado, con reintento ante colisión P2002.
 *
 * Por qué no alcanza con `prisma.cliente.upsert`: bajo el nivel de
 * aislamiento por defecto, dos requests simultáneos con el mismo DNI nuevo
 * pueden ambos evaluar "no existe" y ambos intentar crear, violando el
 * unique constraint en uno de los dos. Mismo patrón de defensa que
 * `products.controller.js`'s `crear()` usa para colisiones de sku
 * (MAX_INTENTOS_SKU + catch de P2002) — acá aplicado a `Cliente.dni`.
 *
 * Regla de negocio: si el cliente YA existe, se actualizan sus datos de
 * contacto con los valores nuevos (el negocio quiere el dato de contacto más
 * reciente, no el primero que se cargó).
 */
async function upsertClienteConReintento(tx, { dni, nombre, telefono, email }) {
  for (let intento = 1; intento <= MAX_INTENTOS_DNI; intento++) {
    const existente = await tx.cliente.findUnique({ where: { dni } });

    if (existente) {
      return tx.cliente.update({
        where: { dni },
        data: { nombre, telefono, email: email ?? null },
      });
    }

    try {
      return await tx.cliente.create({
        data: { dni, nombre, telefono, email: email ?? null },
      });
    } catch (err) {
      const esColisionDni = err?.code === "P2002" && err.meta?.target?.includes?.("dni");
      if (!esColisionDni || intento === MAX_INTENTOS_DNI) throw err;
      // Otro request ganó la carrera y creó el cliente primero — el próximo
      // loop lo encuentra vía findUnique y sigue por la rama de update().
    }
  }
}

/** Lo único que el checkout necesita del perfil, y lo único que puede escribirle. */
const SELECT_PERFIL_CHECKOUT = { nombre: true, telefono: true, dni: true };

/**
 * Lista blanca de lo que el body puede escribir en `CuentaCliente`: SOLO
 * nombre/telefono/dni (spec, `POST /ordenes` con sesión: "opcional
 * `{ nombre, telefono, dni }` (se escriben en la cuenta)").
 *
 * Ni `email` —que sale siempre de la sesión verificada— ni `emailVerificado`,
 * `passwordHash`, `tokenVersion` u `origenRegistro` (amenaza 8, mass
 * assignment). Las reglas de cada campo son las MISMAS que las de
 * `PUT /cuenta` (`cuentaPerfil.controller.js`'s `actualizarPerfil`) y salen de
 * los mismos módulos —`exigirTextoAcotado`, `normalizarDni`/`esDniValido`—
 * para que no puedan divergir: un checkout más permisivo que el perfil
 * escribiría en la cuenta lo que el perfil rechaza.
 *
 * Devuelve `{}` cuando el body no trae ninguno de los tres, que es la señal de
 * que no hay nada que escribir.
 */
function datosDePerfilDelBody(body) {
  const data = {};

  if (body?.nombre !== undefined) {
    data.nombre = exigirTextoAcotado(body.nombre, {
      etiqueta: "El nombre",
      siVacio: "El nombre no puede estar vacío.",
    });
  }
  if (body?.telefono !== undefined) {
    data.telefono = exigirTextoAcotado(body.telefono, {
      etiqueta: "El teléfono",
      siVacio: "El teléfono no puede estar vacío.",
    });
  }
  if (body?.dni !== undefined) {
    const dni = normalizarDni(body.dni);
    if (!esDniValido(dni)) throw httpError(400, "El DNI debe tener 7 u 8 dígitos.");
    data.dni = dni;
  }

  return data;
}

/**
 * Resuelve el contacto de un checkout CON sesión, en dos pasos:
 *
 *   1. Si el body trae `nombre`/`telefono`/`dni`, se ESCRIBEN en la cuenta
 *      (lista blanca, ver `datosDePerfilDelBody`).
 *   2. El contacto de la orden sale de la cuenta —la fila ya actualizada si
 *      hubo escritura, una lectura si no—, y el `email` SIEMPRE de la sesión.
 *
 * `req.cuentaCliente` solo lleva `{ id, email }` (ver
 * `authCliente.middleware.js`), de ahí la consulta. Va FUERA de la
 * transacción, igual que `validarYSnapshotearProductos`.
 *
 * **Por qué el body actualiza el perfil en vez de alimentar la orden**
 * (amenazas 5 y 7): el `Cliente` se busca y se pisa POR DNI, así que si el
 * contacto de la orden saliera del body, un comprador logueado que mande el
 * DNI de otra persona le reescribiría nombre y teléfono a ESA fila y elegiría
 * a qué casilla sale el comprobante. Escribiendo primero en la cuenta, lo
 * único que alguien puede tocar es SU PROPIA cuenta —la sesión decide sobre
 * qué fila se escribe, no el body—, y recién después esa cuenta define el
 * contacto. De paso resuelve el caso real que motivó que el campo sea
 * opcional: una cuenta nacida de Google no tiene DNI, y sin este paso jamás
 * podría comprar aunque la persona lo tipee.
 *
 * Perfil todavía incompleto después del paso 1 → 400 que manda a completarlo,
 * porque `Cliente.nombre` es NOT NULL y el `$transaction` explotaría con un
 * 500 que no dice qué falta.
 */
async function resolverContactoDeLaCuenta(cuentaCliente, body) {
  const cambios = datosDePerfilDelBody(body);

  let perfil;
  if (Object.keys(cambios).length > 0) {
    try {
      perfil = await prisma.cuentaCliente.update({
        where: { id: cuentaCliente.id },
        data: cambios,
        select: SELECT_PERFIL_CHECKOUT,
      });
    } catch (err) {
      // P2025 = la cuenta se borró entre el middleware y esta escritura.
      // Mismo criterio que `actualizarPerfil`: 404, no el 500 opaco de Prisma.
      if (err?.code === "P2025") throw httpError(404, "Cuenta no encontrada.");
      throw err;
    }
  } else {
    perfil = await prisma.cuentaCliente.findUnique({
      where: { id: cuentaCliente.id },
      select: SELECT_PERFIL_CHECKOUT,
    });
  }

  const contacto = {
    dni: perfil?.dni ?? null,
    nombre: perfil?.nombre ?? null,
    telefono: perfil?.telefono ?? null,
    // La identidad verificada de la cuenta, nunca el del body: es la casilla
    // a la que va a salir el comprobante.
    email: cuentaCliente.email,
  };

  if (!contacto.dni || !contacto.nombre || !contacto.telefono) {
    throw httpError(
      400,
      "Completá tu perfil (nombre, teléfono y DNI) antes de continuar con la compra.",
    );
  }

  return contacto;
}

/**
 * Tope de `ClaveIdempotencia.clave`, que es un `VarChar(64)`. Se valida acá
 * porque el driver no rechaza: trunca o revienta con un 500 opaco según el
 * caso, y ninguna de las dos cosas le dice al cliente qué mandó mal.
 */
export const LARGO_MAX_CLAVE_IDEMPOTENCIA = 64;

/**
 * Valida la `claveIdempotencia` del body ANTES de tocar la base: tipo, vacío y
 * largo. Devuelve `null` cuando no vino (que es el caso normal: la clave es
 * opcional) y la clave ya recortada cuando sirve.
 *
 * El chequeo de tipo no es ceremonia: esta clave termina dentro de un `where`
 * de Prisma, y un objeto en el body (`{ "gt": "" }`) es la forma clásica de
 * convertir un campo de texto en un filtro. Va antes de cualquier consulta
 * y de cualquier escritura, incluida la del perfil.
 */
function exigirClaveIdempotencia(valor) {
  if (valor === undefined || valor === null) return null;

  if (typeof valor !== "string") {
    throw httpError(400, "La clave de idempotencia debe ser un texto.");
  }

  const clave = valor.trim();
  if (clave === "") {
    throw httpError(400, "La clave de idempotencia no puede estar vacía.");
  }
  if (clave.length > LARGO_MAX_CLAVE_IDEMPOTENCIA) {
    throw httpError(
      400,
      `La clave de idempotencia no puede superar los ${LARGO_MAX_CLAVE_IDEMPOTENCIA} caracteres.`,
    );
  }

  return clave;
}

/**
 * ¿Este error es el `@@unique([cuentaClienteId, clave])` rechazando el insert
 * de la clave, o es otra colisión?
 *
 * La distinción decide entre devolver la orden del ganador de la carrera y
 * relanzar: tragar cualquier `P2002` como "reenvío" convertiría la colisión de
 * `Cliente.dni` —la que `upsertClienteConReintento` relanza tras agotar sus
 * intentos— en un 200 con la orden de otro envío, o en un 200 sin ninguna.
 *
 * `meta.target` llega como array de columnas en unos conectores y como nombre
 * del índice en otros, así que se normaliza a texto antes de preguntar.
 *
 * ⚠️ El descarte de `ordenId` es por esa segunda forma: esta tabla tiene DOS
 * uniques (`[cuentaClienteId, clave]` y `ordenId`), y el nombre del índice del
 * segundo —`ClaveIdempotencia_ordenId_key`— también contiene "clave", por el
 * nombre del modelo. Sin el descarte, una colisión de `ordenId` se leería como
 * un reenvío y contestaría 200 con la orden de otro envío.
 */
function esColisionDeClaveIdempotencia(err) {
  if (err?.code !== "P2002") return false;
  const target = err.meta?.target;
  const texto = (Array.isArray(target) ? target.join(",") : String(target ?? "")).toLowerCase();
  return texto.includes("clave") && !texto.includes("ordenid");
}

/**
 * La orden que ESTA cuenta ya creó con ESTA clave, o `null`.
 *
 * El `where` lleva las DOS mitades del `@@unique` (amenaza 13, replay
 * cruzado): la clave la elige el cliente, así que una tan adivinable como "1"
 * buscada sin el `cuentaClienteId` le entregaría a cualquiera la orden de otra
 * persona. El scope por cuenta no es una condición extra, es la clave entera.
 *
 * Trae la orden con el include del COMPRADOR (sin `cliente` ni
 * `cuentaCliente`), el mismo que usa el 201: la respuesta del reenvío tiene
 * que ser la misma forma que la del envío original.
 */
async function buscarOrdenDeLaClave(cuentaClienteId, clave) {
  const fila = await prisma.claveIdempotencia.findUnique({
    where: { cuentaClienteId_clave: { cuentaClienteId, clave } },
    include: { orden: { include: DETALLE_ORDEN_CUENTA_INCLUDE } },
  });
  return fila?.orden ?? null;
}

/**
 * POST /api/ordenes — checkout con o sin sesión de cliente. PÚBLICO en el
 * sentido de que no exige auth de ADMIN; ver `ordenes.routes.js` para el
 * `authClienteOpcional` y el corte por `checkoutRequiereCuenta()`. El
 * rate-limiting se aplica a nivel de ruta, no acá.
 *
 * CON SESIÓN (decisión 8 de la spec):
 *   - `nombre`/`telefono`/`dni` del body, si vienen, se escriben en la CUENTA;
 *     el contacto de la orden sale después de esa cuenta y el `email` siempre
 *     de la sesión — ver `resolverContactoDeLaCuenta`.
 *   - La orden se crea con `cuentaClienteId`: es el campo por el que "Mis
 *     pedidos" filtra, y su NULL en las órdenes de invitado es lo que deja el
 *     historial anterior a la cuenta fuera de toda vista logueada.
 *   - La respuesta pasa por `mapOrdenCuenta`, NUNCA por `mapOrden`.
 *
 * SIN SESIÓN: comportamiento IDÉNTICO al checkout de invitado de siempre,
 * eco del body incluido. `upsertClienteConReintento` no cambia de firma en
 * ningún caso — sigue siendo el único escritor de `Cliente`; lo que cambia es
 * QUIÉN llena sus cuatro campos.
 *
 * IDEMPOTENCIA (decisión 9, amenaza 13), solo CON sesión:
 *   - `claveIdempotencia` la elige el cliente y vive en
 *     `ClaveIdempotencia`, con `@@unique([cuentaClienteId, clave])`.
 *   - **Quien arbitra la carrera es ese unique, nunca una lectura.** El lookup
 *     previo existe como atajo del reenvío tranquilo (evita revalidar el
 *     catálogo y repisar el perfil), pero dos requests simultáneos leen los
 *     dos "no existe": el que decide es el `P2002` del `create` DENTRO de la
 *     transacción. Misma regla que `stockDescontado` — la condición vive en la
 *     escritura, no en un `if` sobre una lectura.
 *   - El perdedor no deja media orden: su `create` de orden viaja en la misma
 *     transacción que el de la clave, así que el `P2002` revierte las dos. Y
 *     devuelve **la orden del ganador con 200**, no un error ni una segunda
 *     orden; tampoco notifica ni emite el evento, que ya los disparó el
 *     ganador.
 *   - SIN sesión la clave se IGNORA por completo, sin validarla siquiera: la
 *     tabla está indexada por cuenta, así que no hay nada a qué atarla, y
 *     empezar a rechazar un body que el invitado ya mandaba cambiaría el
 *     checkout de invitado, que no cambia.
 *
 * Orden de validación (todo ANTES de cualquier escritura en DB):
 *   0. Forma de la `claveIdempotencia`, y el corte por reenvío si ya existe.
 *   1. Resolución del contacto, si hay sesión (única consulta nueva).
 *   2. Campos requeridos presentes (dni/nombre/telefono/email/items no vacío).
 *   3. DNI normalizado y válido (7-8 dígitos).
 *   4. Forma de cada item (productId/cantidad enteros positivos).
 *   5. Existencia + visibilidad + disponibilidad de cada producto.
 * Recién después arranca la escritura: upsert de Cliente + creación de
 * Orden/ItemOrden dentro de una misma transacción.
 */
export async function crear(req, res, next) {
  try {
    const cuentaCliente = req.cuentaCliente ?? null;
    const { notas, items } = req.body;

    // Lo PRIMERO, antes de cualquier consulta y de cualquier escritura —
    // incluida la del perfil, que ocurre dentro de `resolverContactoDeLaCuenta`.
    // Sin sesión ni se mira: ver el bloque IDEMPOTENCIA del docstring.
    const claveIdempotencia = cuentaCliente
      ? exigirClaveIdempotencia(req.body?.claveIdempotencia)
      : null;

    if (claveIdempotencia) {
      // El atajo del reenvío tranquilo (el dedo que hace doble click, el
      // reintento del cliente tras un timeout): devuelve la orden que esta
      // cuenta ya creó con esta clave, sin repisar el perfil, sin revalidar el
      // catálogo y sin mandar un segundo comprobante. NO es la guarda de la
      // carrera —esa es el unique de más abajo—, así que dos requests
      // simultáneos pasan de largo por acá los dos, como corresponde.
      const yaCreada = await buscarOrdenDeLaClave(cuentaCliente.id, claveIdempotencia);
      if (yaCreada) return res.status(200).json(mapOrdenCuenta(yaCreada));
    }

    const { dni, nombre, telefono, email } = cuentaCliente
      ? await resolverContactoDeLaCuenta(cuentaCliente, req.body)
      : req.body;

    validarCamposBase({ dni, nombre, telefono, email, items });

    const dniNormalizado = normalizarDni(dni);
    if (!esDniValido(dniNormalizado)) {
      throw httpError(400, "El DNI debe tener 7 u 8 dígitos.");
    }

    validarFormaItems(items);

    const itemsConSnapshot = await validarYSnapshotearProductos(items);

    let orden;
    try {
      orden = await prisma.$transaction(async (tx) => {
        const cliente = await upsertClienteConReintento(tx, {
          dni: dniNormalizado,
          nombre: nombre.trim(),
          telefono: telefono.trim(),
          email: email?.trim() || null,
        });

        const creada = await tx.orden.create({
          data: {
            clienteId: cliente.id,
            // NULL explícito sin sesión: es la nulidad de la que depende que
            // "Mis pedidos" no muestre el historial de invitado de nadie.
            cuentaClienteId: cuentaCliente?.id ?? null,
            notas: notas?.trim() || null,
            items: { create: itemsConSnapshot },
          },
          // El MISMO include con y sin sesión, a propósito: `notificarOrdenCreada`
          // resuelve el destinatario desde `orden.cliente` (fila cruda), así que
          // recortarlo acá dejaría al comprador logueado sin comprobante — con
          // 201 y sin ningún error. Se podrá angostar cuando la Task 8 mueva ese
          // servicio a `contactoDeOrden`. No filtra nada: la respuesta con sesión
          // pasa por `mapOrdenCuenta`, que descarta `cliente` y los dos ids.
          include: { cliente: true, items: true },
        });

        // DENTRO de la misma transacción, y ese "dentro" es toda la garantía:
        // el unique de la clave y la orden commitean juntos o no commitea
        // ninguno. Si esta escritura choca, la orden de ESTE request no llega a
        // existir — por eso el perdedor de la carrera no deja una segunda.
        if (claveIdempotencia) {
          await tx.claveIdempotencia.create({
            data: {
              cuentaClienteId: cuentaCliente.id,
              clave: claveIdempotencia,
              ordenId: creada.id,
            },
          });
        }

        return creada;
      });
    } catch (err) {
      // La carrera, arbitrada por el unique y no por una lectura: el perdedor
      // llega acá con su transacción ENTERA revertida y contesta con la orden
      // que commiteó el ganador.
      if (!claveIdempotencia || !esColisionDeClaveIdempotencia(err)) throw err;

      const ganadora = await buscarOrdenDeLaClave(cuentaCliente.id, claveIdempotencia);
      // Sin fila no hay nada que devolver: el unique rechazó por una clave que
      // ahora no aparece. Es un estado que no debería existir, y un 201 sin
      // orden o un 200 vacío lo esconderían.
      if (!ganadora) throw err;

      // Sin `logEvento` ni `notificarOrdenCreada`: los disparó el ganador. Esta
      // request no creó nada, solo está contando lo que ya pasó.
      return res.status(200).json(mapOrdenCuenta(ganadora));
    }

    // Fire-and-forget: no se espera (ni se deja que una falla acá tumbe la
    // respuesta ya exitosa). Va sin `productId` a propósito: una orden puede
    // tener varios items, así que el evento es a nivel sitio, no de producto.
    logEvento({ tipo: "ORDEN_CREADA", ...headersDeEvento(req) });

    // Fire-and-forget, mismo criterio que `logEvento` de arriba: la orden ya
    // está creada y la respuesta no puede esperar a Gmail ni fallar por él.
    // `notificarOrdenCreada` no lanza por diseño; el `.catch` está por si un
    // cambio futuro la vuelve capaz de hacerlo — una promesa rechazada sin
    // manejar tumba el proceso en Node.
    // Recibe la fila CRUDA, no la mapeada: las plantillas de correo del aviso
    // interno son las únicas consumidoras legítimas del costo, y nunca salen
    // hacia el comprador.
    notificarOrdenCreada(orden).catch(() => {});

    // Mapeada, y sin `esAdmin` en ninguna de las dos ramas: este endpoint lo
    // lee el comprador. Ver `campoDeCosto` en `ordenes.mapper.js` — devolver
    // la fila cruda le filtraba `costoUnitario`, o sea el margen del negocio.
    //
    // Con sesión va por `mapOrdenCuenta`, que además descarta `cliente`,
    // `cuentaCliente` y los dos ids de identidad (amenaza 6: el 201 como
    // oráculo de datos personales). Sin sesión sigue siendo `mapOrden`, con el
    // eco del body intacto — el checkout de invitado no cambia.
    res.status(201).json(cuentaCliente ? mapOrdenCuenta(orden) : mapOrden(orden));
  } catch (err) {
    next(err);
  }
}

/**
 * Construye el `where` de `listar()` (y el de `resumen()`) a partir de los
 * filtros opcionales de query string: estado (match exacto), período sobre
 * `createdAt` (`desde`/`hasta`/`dias`), dni (relation filter contra
 * `Cliente`) y nombre (relation filter contra `Cliente` Y `CuentaCliente`,
 * combinados con `OR` — decisión 12 de la spec: lo que el panel MUESTRA como
 * nombre puede salir de la cuenta). Todos combinables.
 *
 * Mismo criterio que `products.controller.js`'s `construirFiltrosListado`, y
 * dicho sin ambigüedad porque acá los dos comportamientos posibles no dan lo
 * mismo: **un valor malformado NUNCA tira 400/500 y NUNCA cae a un default —
 * esa porción del filtro simplemente NO SE APLICA.**
 *
 *   - `?estado=NO_EXISTE` → no filtra por estado (el listado sigue trayendo los
 *     cuatro).
 *   - `?desde=basura`, `?hasta=31/01/2026`, `?dias=abc`, y también un
 *     `?desde=` vacío → no acotan el período, y la respuesta no trae `periodo`.
 *   - `?dni=`/`?nombre=` vacíos → no filtran por cliente.
 *
 * ⚠️ La regla del período fue lo suficientemente sutil como para haber estado
 * mal: la guarda miraba si la CLAVE existía, así que un `?desde=basura` la daba
 * por presente, `parsearPeriodo` no la sabía leer y caía a su default de últimos
 * 30 días. Eso no es ignorar el filtro: es CAMBIAR el universo de resultados, y
 * sale con 200, sin `recortado: true` y sin ninguna otra señal. Un link
 * compartido con un typo en la fecha escondía el histórico entero, en una
 * pantalla que RESPONDE "¿hay órdenes?".
 *
 * Por eso quien decide es `hayPeriodoPedido` (`admin.controller.js`), que
 * comparte los parsers con `parsearPeriodo` en vez de tener su propia lectura de
 * "¿esta fecha sirve?" — que es exactamente lo que las había dejado en
 * desacuerdo. El default de 30 días sigue vivo y sigue siendo correcto para las
 * cuatro pantallas de analytics, donde el período SIEMPRE existe y la respuesta
 * declara cuál se aplicó.
 *
 * Devuelve `{ where, periodo }` y no solo el `where` porque el período
 * RESUELTO tiene que viajar a la respuesta: la pantalla necesita saber qué
 * rango se aplicó realmente (y si se recortó), igual que en las cuatro
 * pantallas de analytics. `periodo` es `null` cuando nadie pidió uno.
 *
 * `incluirEstado: false` es lo que necesita `resumen()`: ese endpoint cuenta
 * órdenes POR estado, así que respetar el filtro de estado le daría a cada
 * número el suyo propio y tres de los cuatro saldrían en 0.
 */
function construirFiltrosOrdenes(query, { incluirEstado = true } = {}) {
  const where = {};

  if (incluirEstado && query.estado !== undefined && ESTADOS_ORDEN.includes(query.estado)) {
    where.estado = query.estado;
  }

  // La guarda es OBLIGATORIA: `parsearPeriodo` SIEMPRE devuelve un rango (30
  // días por defecto), así que aplicarlo sin condición dejaría a un
  // `GET /ordenes` pelado devolviendo solo el último mes — el preset "Todo" de
  // la pantalla mostraría menos órdenes de las que hay, con 200 y sin error.
  //
  // El parseo va por `parsearPeriodo` y no a mano: `new Date("2026-01-31")` es
  // medianoche UTC, o sea las 21:00 del 30 en Argentina, así que un `lte`
  // armado acá se comía el día 31 entero y corría los dos cortes tres horas.
  // Además es la única casa del calendario argentino: un segundo parser son dos
  // definiciones de "día" que se desincronizan sin que nada falle.
  // Y la guarda pregunta si hay un parámetro de rango UTILIZABLE, no si alguna
  // de las tres claves está presente: ver el ⚠️ del docstring: con
  // `!== undefined`, un `?desde=basura` o un `?desde=` vacío disparaban el
  // default de 30 días. `hayPeriodoPedido` comparte los parsers con
  // `parsearPeriodo`, así que las dos no pueden opinar distinto sobre el mismo
  // valor.
  const hayPeriodo = hayPeriodoPedido(query);

  let periodo = null;
  if (hayPeriodo) {
    periodo = parsearPeriodo(query);
    where.createdAt = { gte: periodo.desde, lte: periodo.hastaInclusive };
  }

  // Dos condiciones independientes, combinadas recién al final: `dni` filtra
  // SOLO `Cliente.dni` (es la identidad comercial; `CuentaCliente.dni` no
  // entra acá — sigue siendo un dato de perfil, no la clave de búsqueda del
  // panel). `nombre` busca en LAS DOS tablas con `OR`: decisión 12 de la
  // spec, "lo que se ve se tiene que poder buscar" — lo que el panel MUESTRA
  // como nombre del cliente hoy puede salir de `CuentaCliente` (ver
  // `mapOrdenListado`), así que buscar solo en `Cliente` dejaría invisibles
  // exactamente las órdenes cuyo nombre visible viene de la cuenta.
  const condiciones = [];

  if (typeof query.dni === "string" && query.dni !== "") {
    condiciones.push({ cliente: { dni: normalizarDni(query.dni) } });
  }

  // Sin `mode: "insensitive"` a propósito: el conector mssql de Prisma no lo
  // soporta y la collation por defecto de esta base ya es case-insensitive
  // (mismo criterio que `products.controller.js`'s `construirFiltrosListado`).
  // Los metacaracteres de LIKE se escapan antes del `contains` — ver
  // `lib/escaparLike.js`.
  if (typeof query.nombre === "string" && query.nombre !== "") {
    const termino = escaparLike(query.nombre);
    condiciones.push({
      OR: [{ cliente: { nombre: { contains: termino } } }, { cuentaCliente: { nombre: { contains: termino } } }],
    });
  }

  // Con UNA sola condición se aplica directo (mismo shape que antes cuando
  // solo había `dni` o solo `nombre`, para no romper ningún consumidor que
  // dependa de esa forma). Con DOS, se combinan con AND explícito: Prisma no
  // permite escribir dos claves `OR` en el mismo nivel del `where`, y un
  // `Object.assign` ciego pisaría la primera condición con la segunda.
  if (condiciones.length === 1) {
    Object.assign(where, condiciones[0]);
  } else if (condiciones.length > 1) {
    where.AND = condiciones;
  }

  return { where, periodo };
}

/**
 * GET /api/ordenes — listado paginado para el panel admin, protegido con
 * requireAuth. Filtros combinables por query string (estado/desde/hasta/dias/
 * dni/nombre), orden por createdAt desc (más reciente primero).
 *
 * El sobre es el de siempre (`{ data, page, pageSize, total }`) más una clave
 * ADITIVA `periodo`, que viaja SOLO cuando el llamador acotó un rango. Sin
 * parámetros de fecha el listado sigue devolviendo el histórico completo.
 *
 * Responde con la forma de LISTADO (`mapOrdenListado`), que no es la del
 * detalle: cliente completo, `total` en plata, `cantidadItems` y un `resumen`
 * de hasta `MAX_ITEMS_RESUMEN` líneas — pero NO las líneas completas. El
 * tablero de órdenes necesita el monto y un vistazo de qué se pidió sin abrir
 * cada orden; `precioUnitario` renglón por renglón no tiene por qué viajar a
 * una grilla, y nada en el schema ni en `crear()` limita cuántos items puede
 * tener una orden.
 *
 * ⚠️ El tope del resumen vive en el MAPPER, nunca como un `take` en el
 * include: con un `take`, el `total` sumaría solo las líneas traídas y
 * publicaría un monto menor que el real, sin error. El detalle línea por línea
 * vive en `obtenerPorId()` — split estándar lista/detalle.
 *
 * Paginación: `parsearPaginacion` de `lib/paginacion.js`, el mismo parser que
 * usan los listados de logs del admin — page/pageSize floored/clamped con
 * defaults sanos.
 */
export async function listar(req, res, next) {
  try {
    const { page, pageSize } = parsearPaginacion(req.query);

    const { where, periodo } = construirFiltrosOrdenes(req.query);

    const [total, ordenes] = await Promise.all([
      prisma.orden.count({ where }),
      prisma.orden.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: LISTADO_ORDEN_INCLUDE,
      }),
    ]);

    // Por `mapOrden` aunque el listado no traiga items: es lo que suma
    // `estadoEtiqueta`, y saltearlo fue exactamente el bug que atrapó el smoke
    // test — la fila cruda de Prisma salía sin etiqueta y el panel caía al
    // respaldo con la clave cruda. `esAdmin: true` porque la ruta está detrás
    // de `requireAuth`.
    res.json({
      data: ordenes.map(mapOrdenListado),
      page,
      pageSize,
      total,
      // Solo cuando el llamador acotó un período. Misma forma exacta que emiten
      // las cuatro pantallas de analytics — así el aviso de "período recortado"
      // del panel es el mismo componente y no un segundo formato. Emitirlo
      // siempre le diría a la pantalla que hay un rango aplicado justo cuando
      // está mostrando el histórico completo.
      ...(periodo !== null && {
        periodo: {
          desde: aClaveDia(periodo.desde),
          hasta: aClaveDia(periodo.hasta),
          recortado: periodo.recortado,
        },
      }),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ordenes/resumen — cuántas órdenes hay en cada estado, protegido con
 * requireAuth. Alimenta los contadores del tablero.
 *
 * Respeta LOS MISMOS filtros que el listado (período, dni, nombre) SALVO
 * `estado`: contar por estado respetando el filtro de estado le daría a cada
 * número el suyo propio, y tres de los cuatro saldrían siempre en 0.
 *
 * UNA sola consulta agrupada, no cuatro `count`: el conteo por estado es
 * exactamente lo que un `groupBy` resuelve en un round-trip.
 *
 * Mismo criterio que `GET /products/resumen`: números GLOBALES del filtro, no
 * de la página — no lo tocan `page` ni `pageSize`.
 */
export async function resumen(req, res, next) {
  try {
    const { where } = construirFiltrosOrdenes(req.query, { incluirEstado: false });

    const conteos = await prisma.orden.groupBy({
      by: ["estado"],
      where,
      _count: { _all: true },
    });

    // ⚠️ `groupBy` OMITE los estados sin ninguna fila: no los devuelve en cero,
    // directamente no vienen. Sembrar los cuatro ANTES de volcar el resultado es
    // lo que hace que "ninguna" se lea como 0 y no como `undefined`, que la
    // pantalla mostraría como un contador vacío.
    const porEstado = {};
    for (const estado of ESTADOS_ORDEN) porEstado[estado] = 0;

    for (const fila of conteos) {
      // `Orden.estado` es un `VarChar(20)` sin enum de base, así que la columna
      // puede llegar a tener un valor que este sistema no conoce (una migración
      // a medio aplicar, un dato viejo). Ese valor NO se emite: la respuesta
      // tiene exactamente las cuatro claves de `ESTADOS_ORDEN`, y una quinta
      // sería una columna que el tablero no sabe dibujar.
      //
      // Se filtra con `includes` y no con `in`, que consulta la cadena de
      // prototipos: un estado llamado `toString` pasaría la guarda.
      if (ESTADOS_ORDEN.includes(fila.estado)) porEstado[fila.estado] = fila._count._all;
    }

    res.json(porEstado);
  } catch (err) {
    next(err);
  }
}

/**
 * Estado que NO cuenta como producto solicitado.
 *
 * Es una regla distinta de `ESTADOS_FACTURABLES` (`admin.controller.js`) y no
 * hay que confundirlas: aquella responde "¿esto es plata ganada?" y por eso
 * deja afuera también a PENDIENTE. Acá la pregunta es "¿cuánta mercadería me
 * están pidiendo?", y una orden pendiente ES demanda real — todavía no
 * descontó stock, pero alguien la va a querer. La cancelada, en cambio, no es
 * mercadería a preparar ni a reponer: sumarla infla el total y hace comprar de
 * más.
 */
const ESTADO_EXCLUIDO_SOLICITADOS = "CANCELADA";

/**
 * Agrupa por producto todo lo que los clientes vienen pidiendo, a través de
 * TODAS las órdenes (sin filtro de fecha) salvo las canceladas.
 *
 * La calculan las DOS rutas del reporte — la grilla y su exportación a
 * `.xlsx`— porque un Excel que no coincide con la pantalla que lo ofrece es
 * peor que no tener Excel: nadie se entera de que difieren.
 *
 * **La clave de agrupamiento cae al snapshot `nombreProducto` cuando no hay
 * `productId`.** Desde que borrar un producto desliga sus líneas
 * (`onDelete: SetNull`), agrupar por `productId` a secas mete a todos los
 * borrados en la clave `null` y suma sus unidades en una sola fila, bajo el
 * nombre del primero. Sin error y sin aviso. Mismo cuidado que el ranking de
 * `resumenVentas`.
 *
 * Sin filtro de fecha, pero no sin techo: la consulta crece para siempre y se
 * reduce entera en memoria, así que lleva el mismo tope y la misma detección
 * de corte que `clientes-resumen` (`MAX_ORDENES_HISTORICO`, una fila de más
 * para saber si hubo recorte, se conservan las MÁS RECIENTES). Con
 * `recortado: true` los totales son un PISO y la pantalla lo declara.
 *
 * @returns {Promise<{data: object[], historico: {ordenesAnalizadas: number, tope: number, recortado: boolean}}>}
 */
export async function calcularProductosSolicitados() {
  const filas = await prisma.orden.findMany({
    where: { estado: { not: ESTADO_EXCLUIDO_SOLICITADOS } },
    orderBy: { createdAt: "desc" },
    take: MAX_ORDENES_HISTORICO + 1,
    select: {
      id: true,
      items: {
        select: {
          productId: true,
          nombreProducto: true,
          precioUnitario: true,
          cantidad: true,
          // El SKU no está en `ItemOrden` — vive en `Product`, así que sale
          // del join. Un producto borrado no tiene ninguno, y esa fila se
          // reporta sin SKU en vez de inventarle uno.
          product: { select: { sku: true } },
        },
      },
    },
  });

  const recortado = filas.length > MAX_ORDENES_HISTORICO;
  const ordenes = recortado ? filas.slice(0, MAX_ORDENES_HISTORICO) : filas;

  // clave -> { productId, sku, nombre, unidades, facturacion, ordenesVistas }
  const porProducto = new Map();

  for (const orden of ordenes) {
    for (const item of orden.items) {
      // El prefijo evita que el nombre "7" de un producto borrado colisione
      // con el `productId` 7 de uno vivo.
      const clave = item.productId ?? `nombre:${item.nombreProducto}`;

      let acumulado = porProducto.get(clave);
      if (!acumulado) {
        acumulado = {
          productId: item.productId ?? null,
          sku: item.product?.sku ?? null,
          // Las órdenes vienen de la más reciente a la más vieja, así que la
          // primera línea que se ve de un producto trae el nombre snapshot
          // más nuevo — el que la persona reconoce hoy.
          nombre: item.nombreProducto,
          unidades: 0,
          facturacion: new Decimal(0),
          // Un producto puede aparecer en dos líneas de la MISMA orden: el
          // conteo es de órdenes distintas, no de líneas.
          ordenesVistas: new Set(),
        };
        porProducto.set(clave, acumulado);
      }

      acumulado.unidades += item.cantidad;
      acumulado.facturacion = acumulado.facturacion.plus(subtotalDeItem(item));
      acumulado.ordenesVistas.add(orden.id);
    }
  }

  // Desempate por nombre: sin él, dos productos con las mismas unidades pueden
  // salir en distinto orden entre la grilla y el Excel de la misma pantalla.
  const data = [...porProducto.values()]
    .sort((a, b) => b.unidades - a.unidades || a.nombre.localeCompare(b.nombre))
    .map((acumulado) => ({
      productId: acumulado.productId,
      sku: acumulado.sku,
      nombre: acumulado.nombre,
      unidades: acumulado.unidades,
      ordenes: acumulado.ordenesVistas.size,
      facturacion: acumulado.facturacion.toFixed(0),
    }));

  return {
    data,
    historico: {
      ordenesAnalizadas: ordenes.length,
      tope: MAX_ORDENES_HISTORICO,
      recortado,
    },
  };
}

/**
 * GET /api/ordenes/productos-solicitados — la grilla agrupada por producto.
 *
 * Es una LECTURA: sin `logAudit`, mismo criterio que `GET /ordenes`.
 */
export async function listarProductosSolicitados(_req, res, next) {
  try {
    res.json(await calcularProductosSolicitados());
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ordenes/productos-solicitados/export — la MISMA grilla, como
 * `.xlsx` descargable.
 */
export async function exportarProductosSolicitados(_req, res, next) {
  try {
    const { data } = await calcularProductosSolicitados();
    const buffer = await generarExportacionSolicitados(data);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="productos-solicitados.xlsx"');
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ordenes/:id — detalle completo de una orden, protegido con
 * requireAuth. Incluye `cliente` e `items` (con nombreProducto/
 * precioUnitario/cantidad ya snapshoteados en ItemOrden, sin necesidad de
 * volver a joinear contra Product). 404 si el id no es numérico o no existe.
 */
export async function obtenerPorId(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Orden no encontrada.");

    const orden = await prisma.orden.findUnique({
      where: { id },
      include: DETALLE_ORDEN_INCLUDE,
    });
    if (!orden) throw httpError(404, "Orden no encontrada.");

    // `mapOrden` con `esAdmin: true`: la ruta exige auth, así que el admin ve
    // `costoUnitario` igual que antes — lo que cambia es que la orden sale con
    // su `estadoEtiqueta`.
    res.json(mapOrden(orden, { esAdmin: true }));
  } catch (err) {
    next(err);
  }
}

/**
 * ¿Esta línea perdió su producto?
 *
 * `ItemOrden.productId` es `Int?` con `onDelete: SetNull`: borrar un producto
 * vendido es un flujo soportado a propósito (23/08/2026) y desliga sus líneas
 * en vez de quedar bloqueado por ellas. La orden sigue siendo legible por sus
 * snapshots, pero ya no hay stock que mover.
 *
 * **Un `where: { id: null }` NO es un no-op.** Un id inexistente sí lo es —
 * `updateMany` devuelve `count: 0` y sigue—, pero `null` es otra cosa: el
 * validador de Prisma lo RECHAZA, porque `Product.id` es un `Int` no nulo. Esa
 * excepción se lanza DENTRO de `prisma.$transaction`, así que revierte el cambio
 * de estado entero y el admin recibe un 500 sin camino alternativo: confirmar o
 * cancelar una orden que contiene un producto borrado quedaba imposible.
 */
function esItemDesligado(item) {
  return item.productId === null || item.productId === undefined;
}

/**
 * PATCH /api/ordenes/:id/estado — cambia el estado de una orden, protegido
 * con requireAuth. Validación manual contra los 4 valores válidos.
 *
 * Deliberadamente SIN máquina de estados: cualquier estado válido puede
 * pasar a cualquier otro (incluso ENTREGADA -> PENDIENTE), sin restricciones
 * sobre el estado de origen. Decisión de diseño ya cerrada en el plan del
 * sprint — el admin es humano y puede necesitar corregir errores de carga.
 *
 * Descuento de stock: al entrar a cualquiera de los dos estados de
 * `ESTADOS_CON_STOCK_TOMADO` (EN_PREPARACION, ENTREGADA) sin tener ya el
 * stock tomado, se descuenta `cantidad` del `stock` de cada producto de la
 * orden (transacción única con el cambio de estado). **Quien manda es
 * `stockDescontado`, no el estado**: si la orden ya tenía el flag encendido
 * — porque ya estaba en uno de esos dos estados, porque se guarda de nuevo
 * el mismo, o porque pasa de EN_PREPARACION a ENTREGADA (o al revés) — el
 * stock NO se descuenta de nuevo; ese caso de re-confirmación queda fuera de
 * alcance (decisión de producto: si hace falta corregir, se ajusta el stock
 * a mano desde el form del producto). La ÚNICA re-confirmación que sí vuelve
 * a descontar es la que viene después de una cancelación, porque esa
 * devolvió las unidades y apagó el flag.
 *
 * Todo el descuento es a prueba de concurrencia, y eso pide dos cosas:
 *
 *   1. La ENTRADA a un estado que toma stock se decide con una escritura
 *      guardada (`updateMany` con `stockDescontado: false` como guarda
 *      ENTERA), nunca con una lectura. Adrede SIN condición sobre el estado
 *      de origen: con DOS estados que descuentan, algo como
 *      `estado: { not: "ENTREGADA" }` dejaría que EN_PREPARACION ->
 *      ENTREGADA matcheara la fila y descontara una segunda vez. Bajo READ
 *      COMMITTED dos PATCH simultáneos pueden ambos releer el mismo estado
 *      dentro de su transacción, pero solo uno logra que ese `updateMany`
 *      matchee la fila — el `count` de esa escritura es el árbitro de quién
 *      descuenta. La relectura dentro de la transacción sigue existiendo,
 *      pero solo para los items a descontar y el estado anterior de la
 *      auditoría, jamás para decidir el descuento.
 *   2. La resta la hace la base con `decrement` sobre el valor vigente de la
 *      fila, no el proceso sobre un valor leído antes. SQL Server corre en
 *      READ COMMITTED: un leer-restar-escribir pierde el descuento de la
 *      transacción que haya escrito en el medio.
 *
 * El `gte` del `where` es el que impide dejar el stock en negativo: si no
 * alcanza, no descuenta. Ese caso no se ignora — un segundo `updateMany`,
 * también guardado, apoya la fila en 0, que es el mismo resultado observable
 * que daba el viejo `Math.max(0, ...)`. Y no es silencioso: cada producto que
 * se apoyó en 0 viaja como string en `advertencias` dentro de la respuesta
 * (el frontend actual ignora campos extra) y como objeto en el detalle del
 * AuditLog (`stockInsuficiente`).
 *
 * Incluye `cliente` e `items` en la respuesta (mismo shape que
 * `obtenerPorId()`), no solo los campos escalares de `Orden`: el frontend
 * (`AdminOrdenDetalle.jsx`) reemplaza su estado completo con esta respuesta
 * (`setOrden(actualizado)`) y renderiza `orden.items.reduce(...)` sin guard —
 * devolver la orden "pelada" (sin include) rompía esa pantalla con un
 * `Cannot read properties of undefined (reading 'reduce')` apenas se
 * cambiaba el estado desde la UI (encontrado en Sprint 7 Task 2, E2E
 * scenario 5, verificado en un browser real).
 */
export async function actualizarEstado(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Orden no encontrada.");

    const { estado } = req.body;
    if (!ESTADOS_ORDEN.includes(estado)) {
      throw httpError(400, `estado debe ser uno de: ${ESTADOS_ORDEN.join(", ")}.`);
    }

    const actual = await prisma.orden.findUnique({ where: { id }, include: { items: true } });
    if (!actual) throw httpError(404, "Orden no encontrada.");

    let estadoAnterior = actual.estado;
    let descontoStock = false;
    let liberoStock = false;
    const faltantes = [];
    const liberados = [];

    const orden = await prisma.$transaction(async (tx) => {
      // Relectura dentro de la transacción: aporta los items a descontar y el
      // estado anterior real para la auditoría. La DECISIÓN de descontar NO
      // sale de esta lectura (ver el comentario del bloque de arriba).
      const vigente = await tx.orden.findUnique({ where: { id }, include: { items: true } });
      if (!vigente) throw httpError(404, "Orden no encontrada.");

      estadoAnterior = vigente.estado;

      if (ESTADOS_CON_STOCK_TOMADO.includes(estado)) {
        // Escritura guardada: el árbitro de la transición es el `count` de esta
        // escritura, nunca una relectura. Bajo READ COMMITTED dos PATCH
        // concurrentes releen lo mismo, pero solo uno gana el X lock y obtiene
        // `count: 1`.
        //
        // `stockDescontado: false` es la guarda entera. La condición sobre el
        // estado de origen se sacó al pasar a DOS estados que descuentan: con
        // `estado: { not: "ENTREGADA" }`, la transición EN_PREPARACION ->
        // ENTREGADA —que debe ser un no-op de stock— matchearía y restaría las
        // unidades por segunda vez.
        //
        // La misma escritura enciende el flag, que es lo que le permite a la
        // cancelación saber que esta orden tiene stock tomado sin deducirlo del
        // estado.
        const transicion = await tx.orden.updateMany({
          where: { id, stockDescontado: false },
          data: { estado, stockDescontado: true },
        });
        descontoStock = transicion.count === 1;
      }

      if (estado === "CANCELADA") {
        // Espejo exacto del descuento, y por la misma razón: el árbitro es una
        // ESCRITURA guardada, nunca una lectura. `stockDescontado: true` en el
        // `where` es lo que garantiza que se devuelva una sola vez — una orden
        // que nunca se confirmó no devuelve nada, y cancelar dos veces
        // devuelve una.
        const transicion = await tx.orden.updateMany({
          where: { id, estado: { not: "CANCELADA" }, stockDescontado: true },
          data: { estado, stockDescontado: false },
        });
        liberoStock = transicion.count === 1;
      }

      if (liberoStock) {
        for (const item of vigente.items) {
          if (esItemDesligado(item)) continue;

          // `increment` sobre el valor vigente de la fila, no el proceso sobre
          // uno leído antes: bajo READ COMMITTED un leer-sumar-escribir pierde
          // lo que haya escrito otra transacción en el medio.
          //
          // Sin guarda de tope: no hay un máximo de stock que respetar. Si la
          // fila no está, `updateMany` devuelve `count: 0` y no pasa nada.
          const { count } = await tx.product.updateMany({
            where: { id: item.productId },
            data: { stock: { increment: item.cantidad } },
          });

          // Se anota SOLO lo que la base efectivamente devolvió. Empujar esto
          // sin mirar el `count` hacía que el AuditLog declarara una devolución
          // que nunca ocurrió — y ese registro es la única traza que existe de
          // una devolución, así que una traza que informa algo que no pasó es
          // peor que no tener ninguna.
          if (count === 1) {
            liberados.push({
              productId: item.productId,
              nombreProducto: item.nombreProducto,
              cantidad: item.cantidad,
            });
          }
        }
      }

      if (descontoStock) {
        for (const item of vigente.items) {
          if (esItemDesligado(item)) continue;

          const { count } = await tx.product.updateMany({
            where: { id: item.productId, stock: { gte: item.cantidad } },
            data: { stock: { decrement: item.cantidad } },
          });

          // Ninguna fila alcanzó el `gte`: o el producto ya no existe, o su
          // stock quedó por debajo de lo pedido (ajuste manual, otra orden).
          // En el segundo caso se apoya en 0 en vez de saltearlo en silencio;
          // el `lt` mantiene el guardado, así que una confirmación concurrente
          // que haya repuesto stock en el medio no se pisa con un cero.
          if (count === 0) {
            await tx.product.updateMany({
              where: { id: item.productId, stock: { lt: item.cantidad } },
              data: { stock: 0 },
            });
            // Sobreventa con señal: el faltante no bloquea la confirmación,
            // pero tampoco pasa en silencio — viaja a la respuesta y al
            // AuditLog (ver después de la transacción).
            faltantes.push({
              productId: item.productId,
              nombreProducto: item.nombreProducto,
              cantidadPedida: item.cantidad,
            });
          }
        }
      }

      // Escribe el estado pedido para las transiciones que la escritura
      // guardada no aplicó — PENDIENTE, que no entra en ningún guardado, o un
      // destino que sí lo intenta pero no matchea porque la orden ya tenía
      // `stockDescontado` en el valor que esa guarda necesitaba (es
      // idempotente respecto de lo que ya decidió el `updateMany`
      // correspondiente) — y devuelve la orden con el shape que espera el
      // frontend (cliente + items, igual que obtenerPorId()).
      return tx.orden.update({
        where: { id },
        data: { estado },
        include: DETALLE_ORDEN_INCLUDE,
      });
    });

    // Solo se audita el cambio de estado (única mutación admin de órdenes).
    // `crear()` NO se audita: es el checkout público de invitado, no una
    // acción de admin — ese flujo ya deja rastro en EventoTrafico.
    logAudit(req, {
      accion: "ACTUALIZAR_ESTADO",
      entidad: "Orden",
      entidadId: id,
      detalle: {
        estadoAnterior,
        estadoNuevo: estado,
        stockDescontado: descontoStock,
        // Solo cuando hubo sobreventa: qué producto, cuánto se pidió y que el
        // stock se apoyó en 0 en vez de descontarse completo.
        ...(faltantes.length > 0 && { stockInsuficiente: faltantes }),
        // Qué se devolvió al cancelar. Se registra con el detalle por producto
        // porque es la única traza de una devolución: si la confirmación se
        // había apoyado en 0 por falta de stock, acá se devuelve la cantidad
        // PEDIDA y no la efectivamente tomada, así que el número puede quedar
        // por encima de la realidad. Es una imprecisión conocida y acotada a
        // ese caso; este registro es lo que la hace rastreable.
        ...(liberados.length > 0 && { stockLiberado: liberados }),
      },
    });

    // `advertencias` viaja solo cuando hubo faltantes; el frontend actual
    // ignora campos extra, así que agregarlo no rompe a ningún consumidor.
    const advertencias = faltantes.map(
      (f) =>
        `Stock insuficiente para "${f.nombreProducto}": se pidieron ${f.cantidadPedida} unidades y el stock se apoyó en 0.`,
    );

    // Notificación al cliente, DESPUÉS de que la transacción commiteó: el
    // estado ya está guardado y un fallo de correo no puede revertirlo.
    //
    // Comparación estricta contra `true`: el default es NO notificar, así que
    // cualquier otro valor (un string, un 1, el campo ausente) se trata como
    // que no se pidió. Un consumidor que no conozca este campo no puede
    // disparar correos por accidente.
    //
    // A diferencia del alta, acá SÍ se espera el resultado: hay una persona
    // en el panel que necesita saber si el cliente se enteró.
    const notificacion =
      req.body?.notificarCliente === true ? await notificarCambioEstado(orden) : undefined;

    res.json({
      ...mapOrden(orden, { esAdmin: true }),
      ...(advertencias.length > 0 && { advertencias }),
      ...(notificacion !== undefined && { notificacion }),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/ordenes/estados — los cuatro estados con su etiqueta y si son
 * terminales.
 *
 * Existe para que el frontend NO tenga su propia copia del diccionario de
 * estados: los selects del panel (filtrar órdenes, cambiar el estado de una)
 * arman sus opciones con esto, y las etiquetas de cada fila viajan como
 * `estadoEtiqueta` en la propia orden. Antes eran un espejo manual entre repos
 * que había que tocar de a dos.
 *
 * Es una constante del proceso — no toca la base — pero va detrás de
 * `requireAuth` igual que el resto del recurso: es información del panel.
 */
export function estados(_req, res) {
  res.json({ estados: listaDeEstados() });
}
