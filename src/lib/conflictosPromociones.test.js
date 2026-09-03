import { describe, expect, it } from "vitest";
import { detectarConflictos, periodosSeSuperponen } from "./conflictosPromociones.js";

/**
 * Guard de la detección de conflictos.
 *
 * LA REGLA QUE MÁS SE MALINTERPRETA: dos promociones simultáneas **no son un
 * conflicto**. El conflicto existe cuando comparten un PRODUCTO durante días
 * que se pisan — y existe solo sobre ese producto, no sobre las promociones
 * enteras.
 *
 * Es el §33 y el §34 del pedido, y es la diferencia entre una alerta útil y una
 * que salta todo el tiempo y se termina ignorando.
 */

function promo(id, nombre, items, periodos) {
  return {
    id,
    nombre,
    items: items.map(([productId, porcentaje, habilitado = true]) => ({
      productId,
      porcentaje,
      habilitado,
      nombreProducto: `Producto ${productId}`,
    })),
    periodos,
  };
}

const SEPTIEMBRE = [{ desde: "2026-09-01", hasta: "2026-09-30" }];

describe("periodosSeSuperponen", () => {
  it("dos rangos que comparten al menos un día se superponen", () => {
    expect(periodosSeSuperponen({ desde: "2026-09-01", hasta: "2026-09-20" }, { desde: "2026-09-10", hasta: "2026-09-15" })).toBe(true);
    // Se tocan en un solo día: el 20.
    expect(periodosSeSuperponen({ desde: "2026-09-01", hasta: "2026-09-20" }, { desde: "2026-09-20", hasta: "2026-09-25" })).toBe(true);
  });

  it("rangos consecutivos que NO comparten ningún día no se superponen", () => {
    expect(periodosSeSuperponen({ desde: "2026-09-01", hasta: "2026-09-19" }, { desde: "2026-09-20", hasta: "2026-09-25" })).toBe(false);
  });
});

describe("detectarConflictos", () => {
  it("dos promociones simultáneas SIN productos en común NO son conflicto", () => {
    // §33. Es la regla que evita que la alerta salte todo el tiempo: sin esto,
    // cualquier par de promos del mismo mes se marcaría, y una alerta que
    // siempre está prendida es una alerta que nadie mira.
    const conflictos = detectarConflictos([
      promo(1, "Promo A", [[10, 10]], SEPTIEMBRE),
      promo(2, "Promo B", [[20, 20]], SEPTIEMBRE),
    ]);

    expect(conflictos).toEqual([]);
  });

  it("el conflicto existe SOLO sobre el producto compartido", () => {
    // §34. Promo A tiene Velador y Pizarra; Promo B tiene Velador y
    // Humidificador. El conflicto es del Velador, y de nada más.
    const conflictos = detectarConflictos([
      promo(1, "Promo A", [[10, 10], [11, 15]], SEPTIEMBRE),
      promo(2, "Promo B", [[10, 20], [12, 15]], SEPTIEMBRE),
    ]);

    expect(conflictos).toHaveLength(1);
    expect(conflictos[0].productId).toBe(10);
  });

  it("emite todo lo que hace falta para decidir sin abrir nada", () => {
    // §40: producto, las dos promociones, sus porcentajes, y cuál predomina.
    const [conflicto] = detectarConflictos([
      promo(1, "Promo Velador", [[10, 10]], SEPTIEMBRE),
      promo(2, "Primavera", [[10, 20]], SEPTIEMBRE),
    ]);

    expect(conflicto).toMatchObject({
      productId: 10,
      nombreProducto: "Producto 10",
      promociones: [
        { id: 1, nombre: "Promo Velador", porcentaje: 10 },
        { id: 2, nombre: "Primavera", porcentaje: 20 },
      ],
    });
  });

  it("dice cuál está PREDOMINANDO: el menor descuento", () => {
    // Es la misma regla que aplica `resolverDescuentos` mientras nadie resuelve
    // el conflicto. La alerta tiene que decir la verdad de lo que el catálogo
    // está mostrando AHORA, no lo que debería.
    const [conflicto] = detectarConflictos([
      promo(1, "Agresiva", [[10, 30]], SEPTIEMBRE),
      promo(2, "Suave", [[10, 10]], SEPTIEMBRE),
    ]);

    expect(conflicto.predominaId).toBe(2);
  });

  it("períodos que NO se pisan no generan conflicto, aunque compartan producto", () => {
    const conflictos = detectarConflictos([
      promo(1, "Promo A", [[10, 10]], [{ desde: "2026-09-01", hasta: "2026-09-10" }]),
      promo(2, "Promo B", [[10, 20]], [{ desde: "2026-09-11", hasta: "2026-09-20" }]),
    ]);

    expect(conflictos).toEqual([]);
  });

  it("una promoción SIN programar no entra en ningún conflicto", () => {
    // §75: sin programación no se aplica a nadie, así que no puede pisarle el
    // precio a nada. Marcarla sería una alerta sobre algo que no está pasando.
    const conflictos = detectarConflictos([
      promo(1, "Programada", [[10, 10]], SEPTIEMBRE),
      promo(2, "Guardada", [[10, 20]], []),
    ]);

    expect(conflictos).toEqual([]);
  });

  it("un producto YA RESUELTO deja de figurar en conflicto", () => {
    // La decisión persistida hace su trabajo: `habilitado: false` saca a ese
    // producto de la competencia, y la alerta se apaga. Si siguiera figurando,
    // resolver un conflicto no tendría ningún efecto visible.
    const conflictos = detectarConflictos([
      promo(1, "Promo A", [[10, 10, false]], SEPTIEMBRE),
      promo(2, "Promo B", [[10, 20]], SEPTIEMBRE),
    ]);

    expect(conflictos).toEqual([]);
  });

  it("con TRES promociones sobre el mismo producto emite UN conflicto con las tres", () => {
    // Un conflicto es del PRODUCTO, no del par: partirlo en tres pares haría
    // que el admin resuelva lo mismo tres veces.
    const conflictos = detectarConflictos([
      promo(1, "A", [[10, 10]], SEPTIEMBRE),
      promo(2, "B", [[10, 20]], SEPTIEMBRE),
      promo(3, "C", [[10, 30]], SEPTIEMBRE),
    ]);

    expect(conflictos).toHaveLength(1);
    expect(conflictos[0].promociones).toHaveLength(3);
  });

  it("una promoción con VARIOS períodos conflictúa si alguno se pisa", () => {
    const conflictos = detectarConflictos([
      promo(1, "A", [[10, 10]], [
        { desde: "2026-01-01", hasta: "2026-01-10" },
        { desde: "2026-09-05", hasta: "2026-09-08" },
      ]),
      promo(2, "B", [[10, 20]], SEPTIEMBRE),
    ]);

    expect(conflictos).toHaveLength(1);
  });

  it("sin promociones devuelve una lista vacía, no null", () => {
    expect(detectarConflictos([])).toEqual([]);
    expect(detectarConflictos(undefined)).toEqual([]);
  });

  it("ordena por producto, para que la lista sea estable entre dos consultas", () => {
    const conflictos = detectarConflictos([
      promo(1, "A", [[30, 10], [10, 10]], SEPTIEMBRE),
      promo(2, "B", [[30, 20], [10, 20]], SEPTIEMBRE),
    ]);

    expect(conflictos.map((c) => c.productId)).toEqual([10, 30]);
  });
});
