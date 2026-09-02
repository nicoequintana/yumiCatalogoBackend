import { describe, expect, it } from "vitest";
import { mapOrden } from "./ordenes.mapper.js";

/**
 * `ItemOrden.costoUnitario` es lo que el negocio PAGA por su mercadería. El
 * único endpoint que crea órdenes es `POST /api/ordenes`, y es PÚBLICO
 * (checkout de invitado, sin `requireAuth`): devolvía la fila cruda de Prisma en
 * su 201, así que le entregaba ese costo —y con él el margen de cada producto—
 * a cualquiera que hiciera una compra o armara el request a mano.
 *
 * Es la misma regla que `camposDePrecio` (`products.mapper.js`) aplica al
 * catálogo, salteada por un `res.json(orden)` sin mapper en el medio.
 */

const ORDEN = {
  id: 100,
  estado: "PENDIENTE",
  cliente: { id: 10, dni: "12345678", nombre: "Juan" },
  items: [
    {
      id: 1,
      productId: 7,
      nombreProducto: "Termo",
      precioUnitario: "3075",
      costoUnitario: "1500",
      cantidad: 2,
    },
  ],
};

describe("mapOrden", () => {
  it("no emite costoUnitario por defecto", () => {
    const salida = mapOrden(ORDEN);

    expect(salida.items[0]).not.toHaveProperty("costoUnitario");
    // El resto del snapshot sí viaja: es lo que el cliente compró y lo que hace
    // legible la orden aunque el producto cambie o se borre después.
    expect(salida.items[0]).toMatchObject({
      nombreProducto: "Termo",
      precioUnitario: "3075",
      cantidad: 2,
    });
    expect(salida.cliente).toEqual(ORDEN.cliente);
  });

  it("emite costoUnitario solo con esAdmin: true", () => {
    expect(mapOrden(ORDEN, { esAdmin: true }).items[0].costoUnitario).toBe("1500");
  });

  it("distingue costo ausente de costo cero", () => {
    const sinCosto = { ...ORDEN, items: [{ ...ORDEN.items[0], costoUnitario: null }] };

    // `null` significa "no se puede calcular el margen de esta línea", NUNCA
    // "margen 0" — quien lo consuma tiene que poder distinguirlos.
    expect(mapOrden(sinCosto, { esAdmin: true }).items[0].costoUnitario).toBeNull();
  });

  it("no inventa items cuando la orden vino sin ellos", () => {
    const { items: _items, ...sinItems } = ORDEN;

    expect(mapOrden(sinItems)).not.toHaveProperty("items");
  });
});

describe("mapOrden — estadoEtiqueta", () => {
  // La etiqueta viaja CON la orden para que el frontend no necesite su propia
  // copia del diccionario de estados. La clave cruda (`estado`) sigue viajando
  // igual: es la que gobierna la lógica (estilos, transiciones); la etiqueta es
  // solo el texto que ve una persona.
  it("emite la etiqueta legible junto al estado crudo", () => {
    const salida = mapOrden(ORDEN);

    expect(salida.estado).toBe("PENDIENTE");
    expect(salida.estadoEtiqueta).toBe("Pendiente");
  });

  it("un estado desconocido cae a la clave cruda, nunca a undefined", () => {
    const salida = mapOrden({ ...ORDEN, estado: "ALGO_NUEVO" });

    expect(salida.estadoEtiqueta).toBe("ALGO_NUEVO");
  });
});
