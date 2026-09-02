/**
 * Costeo y precios de producto: los dos únicos endpoints que escriben `costo`,
 * `coeficiente` y `precio`.
 *
 * VIVE APARTE de `products.controller.js` porque ese archivo llegó a 1650
 * líneas con ocho responsabilidades distintas (catálogo público, CRUD, toggles
 * del listado, acciones masivas, costeo, pantallas del panel, media y n8n), y
 * esta es la más joven y mejor delimitada de las ocho: se apoya en su propio
 * módulo de dominio (`lib/precios.js`) y no comparte estado con las demás.
 *
 * LAS RUTAS NO CAMBIARON. `products.routes.js` sigue montando los mismos
 * handlers con los mismos nombres, así que el contrato HTTP es idéntico y la
 * suite existente es la red que lo verifica.
 *
 * NO CONFUNDIR LOS DOS ENDPOINTS:
 *
 *  - `PATCH /products/:id/costeo` guarda costo y coeficiente y **NO toca
 *    `precio`**. Eso es exactamente lo que sostiene el flujo `DIFIERE`: el
 *    producto queda marcado como "el precio publicado ya no es el calculado"
 *    hasta que una persona decida aplicarlo.
 *  - `POST /products/precios-masivo` es **el único que PUBLICA un precio** en un
 *    producto que ya tenía uno.
 *
 * Fusionarlos parece una simplificación y rompería el paso de revisión entero.
 */

import { prisma } from "../lib/prisma.js";
import { logAudit } from "../lib/logAudit.js";
import { httpError } from "../lib/httpError.js";
import { calcularPrecio } from "../lib/precios.js";
import { PRODUCT_INCLUDE, mapProducto } from "./products.mapper.js";
import { validarCostoYCoeficiente, parsearIdsMasivos } from "./products.input.js";

/**
 * Guarda el costo y el coeficiente de un producto desde la pantalla de precios,
 * al instante y sin pasar por el formulario completo.
 *
 * Es el tercer hermano de `actualizarVisibilidad` y `actualizarMerchandising`, y
 * existe por el mismo motivo: son campos que se editan desde una TABLA, donde
 * mandar un `PUT` multipart con el producto entero por dos números sería
 * absurdo y además pisaría lo que otra pestaña haya cambiado mientras tanto.
 *
 * **NO toca `precio`.** Guardar un costo nunca mueve el precio publicado: eso
 * lo hace `aplicarPreciosMasivo`, a pedido explícito. Es la invariante central
 * de la feature y el motivo de que estos dos endpoints estén separados.
 *
 * Acepta JSON. `null`/`""` borran la columna — ver `validarCostoYCoeficiente`.
 */
export async function actualizarCosteo(req, res, next) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw httpError(404, "Producto no encontrado.");

    const { costo, coeficiente } = req.body ?? {};
    if (costo === undefined && coeficiente === undefined) {
      throw httpError(400, "Debe enviar costo o coeficiente.");
    }
    // Mismo modo que el PUT: se puede mandar solo uno de los dos (la tabla de
    // precios guarda campo por campo, al salir de cada celda), pero ninguno se
    // puede vaciar. Antes un `""` borraba la columna, y desde que el precio se
    // deriva eso deja al producto sin forma de recalcularlo.
    const costeo = validarCostoYCoeficiente({ costo, coeficiente }, { modo: "edicion" });

    const existente = await prisma.product.findUnique({ where: { id } });
    if (!existente) throw httpError(404, "Producto no encontrado.");

    const producto = await prisma.product.update({
      where: { id },
      data: { costo: costeo.costo, coeficiente: costeo.coeficiente },
      include: PRODUCT_INCLUDE,
    });

    logAudit(req, {
      accion: "ACTUALIZAR_COSTEO",
      entidad: "Producto",
      entidadId: id,
      detalle: {
        costoAnterior: existente.costo?.toString() ?? null,
        costoNuevo: producto.costo?.toString() ?? null,
        coeficienteAnterior: existente.coeficiente?.toString() ?? null,
        coeficienteNuevo: producto.coeficiente?.toString() ?? null,
      },
    });

    res.json(mapProducto(producto, { esAdmin: true }));
  } catch (err) {
    next(err);
  }
}

/**
 * Aplica el precio calculado (`costo × coeficiente`, redondeado al peso) a los
 * productos seleccionados en la pantalla de precios.
 *
 * **Este endpoint es el único que escribe un precio derivado del costo, y esa
 * es toda la feature.** `precio` sigue siendo una columna propia: cambiar el
 * costo de un producto NO mueve su precio publicado hasta que alguien pase por
 * acá. Es lo que hace que el precio que ve el cliente sea siempre un número que
 * una persona aprobó, y lo que permite que el redondeo se muestre en pantalla
 * antes de escribirse en vez de ocurrir en silencio.
 *
 * `coeficiente` en el body es OPCIONAL y pisa el de cada producto — es el campo
 * "aplicar este coeficiente a los N seleccionados". Se guarda junto con el
 * precio: si solo se usara para la cuenta, el producto quedaría con un precio
 * que su propio coeficiente no explica, y la pantalla lo marcaría DIFIERE al
 * instante siguiente.
 *
 * **Validar primero, escribir después.** Los productos que no se pueden
 * precisar (sin costo, o inexistentes) se apartan ANTES de la transacción, con
 * su motivo. Así un producto sin costo no aborta el lote entero, y el informe
 * distingue "no se tocó" de "se tocó y no cambió" — un `{ ok: true }` después
 * de aplicar sobre 40 y haber escrito 31 sería una mentira.
 */
export async function aplicarPreciosMasivo(req, res, next) {
  try {
    const ids = parsearIdsMasivos(req.body?.ids);

    // El override se valida antes de leer la base: si viene mal, no tiene
    // sentido haber consultado nada.
    const { coeficiente: coeficienteOverride } = validarCostoYCoeficiente({
      coeficiente: req.body?.coeficiente,
    });

    const productos = await prisma.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, nombre: true, precio: true, costo: true, coeficiente: true },
    });
    const porId = new Map(productos.map((p) => [p.id, p]));

    const resultados = [];
    const rechazados = [];
    const aEscribir = [];

    // Se itera sobre `ids` y no sobre `productos` para que un id inexistente
    // aparezca en el informe con su motivo, mismo criterio que `eliminarMasivo`.
    for (const id of ids) {
      const producto = porId.get(id);
      if (!producto) {
        rechazados.push({ id, nombre: null, motivo: "El producto no existe." });
        continue;
      }

      const coeficienteEfectivo = coeficienteOverride ?? producto.coeficiente;
      const precioNuevo = calcularPrecio(producto.costo, coeficienteEfectivo);
      if (precioNuevo === null) {
        rechazados.push({
          id,
          nombre: producto.nombre,
          motivo: "No tiene costo y coeficiente cargados.",
        });
        continue;
      }

      const precioAnterior = producto.precio.toString();
      const cambiaPrecio = !producto.precio.equals(precioNuevo);
      const cambiaCoeficiente =
        coeficienteOverride !== undefined &&
        coeficienteOverride !== null &&
        !producto.coeficiente?.equals(coeficienteOverride);

      resultados.push({
        id,
        nombre: producto.nombre,
        precioAnterior,
        precioNuevo: precioNuevo.toString(),
        cambio: cambiaPrecio,
      });

      // Un producto ya al día no se reescribe: sin esto, cada aplicación
      // masiva llenaría `AuditLog` de cambios que no cambiaron nada y
      // esconderían los reales.
      if (cambiaPrecio || cambiaCoeficiente) {
        aEscribir.push({
          id,
          precioAnterior,
          data: {
            precio: precioNuevo.toString(),
            ...(cambiaCoeficiente && { coeficiente: coeficienteOverride }),
          },
        });
      }
    }

    // Todo o nada sobre lo que SÍ se puede escribir. Lo rechazado ya quedó
    // afuera, así que la transacción no puede abortar por un dato faltante.
    if (aEscribir.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const { id, data } of aEscribir) {
          await tx.product.update({ where: { id }, data });
        }
      });
    }

    // Un renglón por producto, no uno por lote: mismo criterio que
    // `actualizarVisibilidadMasiva`.
    for (const { id, precioAnterior, data } of aEscribir) {
      logAudit(req, {
        accion: "APLICAR_PRECIO",
        entidad: "Producto",
        entidadId: id,
        detalle: {
          precioAnterior,
          precioNuevo: data.precio,
          ...(data.coeficiente !== undefined && { coeficiente: data.coeficiente }),
          masivo: true,
        },
      });
    }

    res.json({ actualizados: aEscribir.length, resultados, rechazados });
  } catch (err) {
    next(err);
  }
}

