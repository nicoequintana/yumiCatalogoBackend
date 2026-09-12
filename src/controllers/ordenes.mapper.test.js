import { describe, expect, it } from "vitest";
import {
  DETALLE_ORDEN_CUENTA_INCLUDE,
  DETALLE_ORDEN_INCLUDE,
  LISTADO_ORDEN_CUENTA_INCLUDE,
  LISTADO_ORDEN_INCLUDE,
  MAX_ITEMS_RESUMEN,
  contactoDeOrden,
  mapOrden,
  mapOrdenCuenta,
  mapOrdenCuentaListado,
  mapOrdenListado,
} from "./ordenes.mapper.js";

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

/**
 * `mapItemOrden` — la portada del producto.
 *
 * El detalle de una orden joinea `product` para mostrar la miniatura de cada
 * línea. Ese join es exactamente lo que vuelve peligroso el spread del mapper:
 * la fila de `Product` lleva `costo` y `coeficiente`, que son ADMIN-ONLY, y el
 * MISMO `mapItemOrden` sirve al 201 de `POST /api/ordenes`, que es PÚBLICO.
 */

/** Una línea tal como la devuelve el detalle: con el producto joineado. */
const ITEM_CON_PRODUCTO = {
  id: 1,
  productId: 7,
  nombreProducto: "Termo",
  precioUnitario: "3075",
  costoUnitario: "1500",
  cantidad: 2,
  product: { fotos: [{ url: "https://res.cloudinary.com/demo/termo.jpg" }] },
};

describe("mapOrden — fotoPortada de cada ítem", () => {
  it("emite la url de la primera foto del producto joineado", () => {
    const salida = mapOrden({ ...ORDEN, items: [ITEM_CON_PRODUCTO] }, { esAdmin: true });

    expect(salida.items[0].fotoPortada).toBe("https://res.cloudinary.com/demo/termo.jpg");
  });

  it("emite null cuando el producto fue borrado", () => {
    // `ItemOrden.productId` es nullable con `onDelete: SetNull`: borrar un
    // producto DESLIGA sus líneas históricas en vez de bloquear el borrado, así
    // que Prisma devuelve `product: null` y la orden sigue siendo legible por
    // sus snapshots.
    const item = { ...ITEM_CON_PRODUCTO, productId: null, product: null };
    const salida = mapOrden({ ...ORDEN, items: [item] }, { esAdmin: true });

    expect(salida.items[0].fotoPortada).toBeNull();
  });

  it("emite null cuando el producto existe pero no tiene fotos", () => {
    const item = { ...ITEM_CON_PRODUCTO, product: { fotos: [] } };
    const salida = mapOrden({ ...ORDEN, items: [item] }, { esAdmin: true });

    expect(salida.items[0].fotoPortada).toBeNull();
  });

  it("NO emite la clave cuando nadie joineó el producto", () => {
    // Ausente y `null` significan cosas distintas: ausente es "no pregunté"
    // (el 201 del checkout público usa `items: true` a secas), `null` es
    // "pregunté y no hay portada". Emitir `null` en el primer caso le haría
    // creer al consumidor que el producto no tiene foto.
    const salida = mapOrden(ORDEN, { esAdmin: true });

    expect(salida.items[0]).not.toHaveProperty("fotoPortada");
  });

  it("NUNCA emite el producto joineado, ni siquiera para un admin", () => {
    // La fila de `Product` lleva `costo` y `coeficiente`. La query del detalle
    // usa un `select` mínimo, pero el mapper es la ÚLTIMA línea de defensa: el
    // día que alguien ensanche ese select "para mostrar el stock", el spread
    // ciego se lo entregaría al comprador anónimo del checkout.
    const item = {
      ...ITEM_CON_PRODUCTO,
      product: { costo: "500", coeficiente: "2.5", fotos: ITEM_CON_PRODUCTO.product.fotos },
    };
    const salida = mapOrden({ ...ORDEN, items: [item] }, { esAdmin: true });

    expect(salida.items[0]).not.toHaveProperty("product");
    expect(JSON.stringify(salida)).not.toContain("coeficiente");
  });
});

/**
 * `mapOrdenListado` — la forma del LISTADO, que no es la del detalle.
 *
 * Espeja el par `mapProductoListado` / `mapProducto` de `products.mapper.js`.
 * El tablero de órdenes necesita el monto y un vistazo de qué se pidió sin
 * abrir cada orden, pero NO las líneas completas: `precioUnitario` renglón por
 * renglón no tiene por qué viajar a una grilla.
 *
 * No recibe `esAdmin` a propósito: como nunca emite `items`, no existe camino
 * por el que pueda publicar `costoUnitario`.
 */

const ORDEN_LISTADO = {
  id: 100,
  estado: "PENDIENTE",
  cliente: { id: 10, dni: "12345678", nombre: "Juan", email: "juan@ejemplo.com" },
  items: [
    { nombreProducto: "Termo", precioUnitario: "3075", cantidad: 2 },
    { nombreProducto: "Mate", precioUnitario: "2000", cantidad: 1 },
  ],
};

describe("mapOrdenListado", () => {
  it("emite el total como string entero, sin separador decimal", () => {
    // 3075*2 + 2000*1 = 8150. Los montos del sistema no tienen centavos y
    // viajan como string, igual que en `mapProducto`.
    expect(mapOrdenListado(ORDEN_LISTADO).total).toBe("8150");
  });

  it("emite el resumen sin el precio de cada línea", () => {
    const { resumen } = mapOrdenListado(ORDEN_LISTADO);

    expect(resumen).toEqual([
      { nombreProducto: "Termo", cantidad: 2 },
      { nombreProducto: "Mate", cantidad: 1 },
    ]);
    expect(resumen[0]).not.toHaveProperty("precioUnitario");
  });

  it("cuenta los ítems y NO emite items ni _count", () => {
    const salida = mapOrdenListado({ ...ORDEN_LISTADO, _count: { items: 2 } });

    expect(salida.cantidadItems).toBe(2);
    // `items` ausente es el guard de que `precioUnitario` línea por línea no se
    // filtra al listado; `_count` desaparece porque `cantidadItems` lo reemplaza.
    expect(salida).not.toHaveProperty("items");
    expect(salida).not.toHaveProperty("_count");
  });

  it("topea el resumen pero suma y cuenta TODAS las líneas", () => {
    // El test más importante del mapper. El tope existe para acotar el payload
    // del hover, y tiene que vivir ACÁ: bajarlo a la query como un `take` haría
    // que el total sume 5 de N líneas y publique un monto MENOR que el real,
    // sin error y sin nada que lo delate.
    const items = Array.from({ length: 7 }, (_, i) => ({
      nombreProducto: `Producto ${i + 1}`,
      precioUnitario: "1000",
      cantidad: 1,
    }));

    const salida = mapOrdenListado({ ...ORDEN_LISTADO, items });

    expect(salida.resumen).toHaveLength(MAX_ITEMS_RESUMEN);
    expect(salida.cantidadItems).toBe(7);
    expect(salida.total).toBe("7000");
  });

  it("emite null en los tres derivados cuando nadie joineó los ítems", () => {
    // `totalDeItems` tolera `items` ausente devolviendo `Decimal(0)`, así que
    // sin esta guarda una orden sin join se publicaría como `$ 0` — un monto
    // inventado, sin error y sin test rojo. Mismo criterio que `costoDeItem`,
    // que devuelve `null` y jamás `Decimal(0)`.
    const { items: _items, ...sinItems } = ORDEN_LISTADO;
    const salida = mapOrdenListado(sinItems);

    expect(salida.total).toBeNull();
    expect(salida.cantidadItems).toBeNull();
    expect(salida.resumen).toBeNull();
  });

  it("conserva el cliente completo y la etiqueta del estado", () => {
    const salida = mapOrdenListado(ORDEN_LISTADO);

    // El cliente NO se recorta: `DialogoNotificarEstado` decide si se puede
    // notificar con `Boolean(cliente.email)`, así que sin el email ningún
    // cliente sería notificable desde el tablero.
    expect(salida.cliente).toEqual(ORDEN_LISTADO.cliente);
    expect(salida.estado).toBe("PENDIENTE");
    expect(salida.estadoEtiqueta).toBe("Pendiente");
  });

  it("nunca emite costoUnitario", () => {
    const conCosto = {
      ...ORDEN_LISTADO,
      items: [{ ...ORDEN_LISTADO.items[0], costoUnitario: "1500" }],
    };

    expect(JSON.stringify(mapOrdenListado(conCosto))).not.toContain("costoUnitario");
  });
});

/**
 * Decisión 8 (cuentas de cliente, parte 3): el contacto de una orden con
 * cuenta se resuelve desde `CuentaCliente`, nunca se expone crudo, y el `dni`
 * sigue viajando SIEMPRE de `Cliente`.
 */

const CUENTA_SELECT = { id: true, nombre: true, telefono: true, email: true };

describe("includes del admin — decisión 8", () => {
  it("DETALLE_ORDEN_INCLUDE joinea cuentaCliente con select explícito, nunca true", () => {
    expect(DETALLE_ORDEN_INCLUDE.cuentaCliente).toEqual({ select: CUENTA_SELECT });
  });

  it("LISTADO_ORDEN_INCLUDE joinea cuentaCliente con select explícito, nunca true", () => {
    expect(LISTADO_ORDEN_INCLUDE.cuentaCliente).toEqual({ select: CUENTA_SELECT });
  });
});

describe("mapOrden — contacto resuelto (decisión 8 y 12)", () => {
  const CLIENTE = { id: 1, dni: "12345678", nombre: "Juan Invitado", telefono: "111", email: "juan@viejo.com" };
  const CUENTA = { id: 9, nombre: "Juan Cuenta", telefono: "222", email: "juan@cuenta.com" };

  it("con cuentaCliente, nombre/telefono/email salen de la cuenta", () => {
    const mapeada = mapOrden({ id: 1, estado: "PENDIENTE", cliente: CLIENTE, cuentaCliente: CUENTA });
    expect(mapeada.cliente.nombre).toBe("Juan Cuenta");
    expect(mapeada.cliente.telefono).toBe("222");
    expect(mapeada.cliente.email).toBe("juan@cuenta.com");
  });

  it("el dni SIEMPRE sale de Cliente, nunca de CuentaCliente", () => {
    const mapeada = mapOrden({ id: 1, estado: "PENDIENTE", cliente: CLIENTE, cuentaCliente: { ...CUENTA, dni: "99999999" } });
    expect(mapeada.cliente.dni).toBe("12345678");
  });

  it("campo por campo: un hueco en la cuenta cae al Cliente, no rompe el resto", () => {
    const cuentaIncompleta = { id: 9, nombre: null, telefono: null, email: "juan@cuenta.com" };
    const mapeada = mapOrden({ id: 1, estado: "PENDIENTE", cliente: CLIENTE, cuentaCliente: cuentaIncompleta });
    expect(mapeada.cliente.nombre).toBe("Juan Invitado");
    expect(mapeada.cliente.telefono).toBe("111");
    expect(mapeada.cliente.email).toBe("juan@cuenta.com");
  });

  it("sin cuentaCliente (orden de invitado), el cliente viaja tal cual", () => {
    const mapeada = mapOrden({ id: 1, estado: "PENDIENTE", cliente: CLIENTE });
    expect(mapeada.cliente).toEqual(CLIENTE);
  });

  it("la respuesta NUNCA expone la clave cuentaCliente cruda", () => {
    const mapeada = mapOrden({ id: 1, estado: "PENDIENTE", cliente: CLIENTE, cuentaCliente: CUENTA });
    expect(mapeada).not.toHaveProperty("cuentaCliente");
    expect(JSON.stringify(mapeada)).not.toContain("cuentaCliente");
  });

  it("orden sin cliente joineado no explota (mapOrden tolera cliente ausente)", () => {
    expect(() => mapOrden({ id: 1, estado: "PENDIENTE" })).not.toThrow();
  });
});

describe("mapOrdenListado — mismo contacto resuelto que mapOrden", () => {
  it("resuelve nombre desde la cuenta y no expone cuentaCliente", () => {
    const orden = {
      id: 1,
      estado: "PENDIENTE",
      cliente: { nombre: "Invitado", telefono: "1", email: "a@a.com" },
      cuentaCliente: { nombre: "De la cuenta", telefono: "2", email: "b@b.com" },
      items: [{ nombreProducto: "X", precioUnitario: "100", cantidad: 1 }],
    };
    const mapeada = mapOrdenListado(orden);
    expect(mapeada.cliente.nombre).toBe("De la cuenta");
    expect(mapeada).not.toHaveProperty("cuentaCliente");
  });
});

describe("contactoDeOrden — decisión 8, preferencia de OBJETO completo", () => {
  it("con cuentaCliente, usa la cuenta ENTERA (no mezcla campos)", () => {
    const orden = {
      cliente: { nombre: "Invitado", telefono: "111", email: "viejo@x.com" },
      cuentaCliente: { nombre: "Cuenta", telefono: "222", email: "nuevo@x.com" },
    };
    expect(contactoDeOrden(orden)).toEqual({ nombre: "Cuenta", telefono: "222", email: "nuevo@x.com" });
  });

  it("sin cuentaCliente, cae a Cliente entero", () => {
    const orden = { cliente: { nombre: "Invitado", telefono: "111", email: "viejo@x.com" } };
    expect(contactoDeOrden(orden)).toEqual({ nombre: "Invitado", telefono: "111", email: "viejo@x.com" });
  });

  it("sin ninguno de los dos, devuelve los tres campos en null (nunca explota)", () => {
    expect(contactoDeOrden({})).toEqual({ nombre: null, telefono: null, email: null });
  });

  it("con orden null o undefined, nunca explota (fix round 1)", () => {
    // `notificacionesOrden.service.js` llama a esto fire-and-forget: si
    // tirara, el `.catch` de ese servicio se lo traga y el mail desaparece
    // sin dejar rastro. A diferencia de `mapOrden`/`mapOrdenListado`, esta
    // función no tenía guarda de falsy — se agrega acá.
    expect(contactoDeOrden(null)).toEqual({ nombre: null, telefono: null, email: null });
    expect(contactoDeOrden(undefined)).toEqual({ nombre: null, telefono: null, email: null });
  });
});

/**
 * Fix round 1 — amenazas 6/7: `mapOrdenCuenta`/`mapOrdenCuentaListado` (y sus
 * includes) son el guard entero de "ninguna superficie del comprador emite
 * `Cliente`/`CuentaCliente`". Hasta ahora el invariante vivía solo en un
 * docstring; estos tests lo fijan para que un edit futuro que borre una
 * clave del destructuring falle en rojo en vez de filtrar en silencio.
 */

const ORDEN_CON_CONTACTO = {
  id: 1,
  estado: "PENDIENTE",
  clienteId: 10,
  cuentaClienteId: 9,
  cliente: { id: 10, dni: "12345678", nombre: "Juan Invitado", telefono: "111", email: "juan@viejo.com" },
  cuentaCliente: { id: 9, nombre: "Juan Cuenta", telefono: "222", email: "juan@cuenta.com" },
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

describe("mapOrdenCuenta — invariante permanente (amenazas 6/7)", () => {
  it("nunca emite cliente, cuentaCliente, clienteId, cuentaClienteId ni costoUnitario", () => {
    const salida = mapOrdenCuenta(ORDEN_CON_CONTACTO);
    const crudo = JSON.stringify(salida);

    expect(crudo).not.toContain("cuentaCliente");
    expect(crudo).not.toContain("clienteId");
    expect(crudo).not.toContain("cuentaClienteId");
    expect(crudo).not.toContain("costoUnitario");
    expect(salida).not.toHaveProperty("cliente");
  });
});

describe("mapOrdenCuenta — total del detalle", () => {
  // Bug: el detalle de "Mis pedidos" no emitía `total` y el frontend mostraba
  // "$ 0" para un pedido que en el listado valía $ 40.025. `Orden` no tiene
  // columna `total`: sale de los ítems, igual que en `mapOrdenCuentaListado`.
  it("suma cantidad × precio de TODAS las líneas", () => {
    const salida = mapOrdenCuenta({
      id: 7117,
      estado: "PENDIENTE",
      items: [
        { nombreProducto: "Encendedor", precioUnitario: "8005", cantidad: 5 },
        { nombreProducto: "Mate", precioUnitario: "1000", cantidad: 1 },
      ],
    });

    expect(salida.total).toBe("41025");
  });

  it("emite null cuando nadie joineó los ítems, nunca un $ 0 inventado", () => {
    const salida = mapOrdenCuenta({ id: 7117, estado: "PENDIENTE" });

    expect(salida.total).toBeNull();
  });
});

describe("mapOrdenCuentaListado — invariante permanente (amenazas 6/7)", () => {
  it("nunca emite cliente, cuentaCliente, clienteId, cuentaClienteId ni costoUnitario", () => {
    const salida = mapOrdenCuentaListado(ORDEN_CON_CONTACTO);
    const crudo = JSON.stringify(salida);

    expect(crudo).not.toContain("cuentaCliente");
    expect(crudo).not.toContain("clienteId");
    expect(crudo).not.toContain("cuentaClienteId");
    expect(crudo).not.toContain("costoUnitario");
    expect(salida).not.toHaveProperty("cliente");
  });
});

describe("includes de la superficie del comprador — nunca joinean cliente/cuentaCliente", () => {
  it("DETALLE_ORDEN_CUENTA_INCLUDE no declara cliente ni cuentaCliente", () => {
    expect(DETALLE_ORDEN_CUENTA_INCLUDE).not.toHaveProperty("cliente");
    expect(DETALLE_ORDEN_CUENTA_INCLUDE).not.toHaveProperty("cuentaCliente");
  });

  it("LISTADO_ORDEN_CUENTA_INCLUDE no declara cliente ni cuentaCliente", () => {
    expect(LISTADO_ORDEN_CUENTA_INCLUDE).not.toHaveProperty("cliente");
    expect(LISTADO_ORDEN_CUENTA_INCLUDE).not.toHaveProperty("cuentaCliente");
  });
});

/**
 * Guard adversarial con datos ajenos: verifica que valores de contacto
 * de diferentes personas NO sobreviven en la salida serializada.
 */

describe("mapOrdenCuenta — Amenaza 6/7: nunca expone el contacto de nadie", () => {
  const ORDEN_CON_DATOS_AJENOS = {
    id: 55,
    estado: "PENDIENTE",
    clienteId: 3,
    cuentaClienteId: 9,
    cliente: { id: 3, dni: "11222333", nombre: "Persona Ajena", telefono: "999", email: "ajeno@x.com" },
    cuentaCliente: { id: 9, nombre: "Otra Persona", telefono: "888", email: "otra@x.com" },
    items: [{ nombreProducto: "Termo", precioUnitario: "20000", costoUnitario: "8000", cantidad: 1 }],
  };

  it("el objeto resultante no tiene las claves cliente/cuentaCliente/clienteId/cuentaClienteId", () => {
    const mapeada = mapOrdenCuenta(ORDEN_CON_DATOS_AJENOS);
    expect(mapeada).not.toHaveProperty("cliente");
    expect(mapeada).not.toHaveProperty("cuentaCliente");
    expect(mapeada).not.toHaveProperty("clienteId");
    expect(mapeada).not.toHaveProperty("cuentaClienteId");
  });

  it("ningún string de contacto sobrevive en el JSON serializado", () => {
    const mapeada = mapOrdenCuenta(ORDEN_CON_DATOS_AJENOS);
    const serializado = JSON.stringify(mapeada);
    for (const dato of ["Persona Ajena", "Otra Persona", "999", "888", "ajeno@x.com", "otra@x.com", "11222333"]) {
      expect(serializado).not.toContain(dato);
    }
  });

  it("tampoco expone costoUnitario", () => {
    const mapeada = mapOrdenCuenta(ORDEN_CON_DATOS_AJENOS);
    const serializado = JSON.stringify(mapeada);
    expect(serializado).not.toContain("costoUnitario");
    expect(serializado).not.toContain("8000");
  });

  it("mapOrdenCuentaListado sostiene el mismo guard", () => {
    const mapeada = mapOrdenCuentaListado({ ...ORDEN_CON_DATOS_AJENOS, items: ORDEN_CON_DATOS_AJENOS.items });
    const serializado = JSON.stringify(mapeada);
    expect(serializado).not.toContain("Persona Ajena");
    expect(serializado).not.toContain("Otra Persona");
    expect(mapeada).not.toHaveProperty("cliente");
  });
});
