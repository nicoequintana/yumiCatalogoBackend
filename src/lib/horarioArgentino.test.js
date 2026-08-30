import { describe, expect, it } from "vitest";
import {
  DESFASE_ARGENTINA_MS,
  claveDiaArgentino,
  enHorarioArgentino,
  inicioDelDiaArgentino,
} from "./horarioArgentino.js";

/**
 * La única definición de "día" del sistema.
 *
 * El contenedor corre en UTC y el negocio vive en Buenos Aires: entre las 21:00
 * y la medianoche local, el día UTC y el argentino NO coinciden, y ahí es
 * justamente cuando más se compra. Todos los casos de abajo caen en esa franja.
 */

describe("claveDiaArgentino", () => {
  it("una venta de las 22:30 ART pertenece a SU día, no al UTC del día siguiente", () => {
    // 2026-08-16T01:30Z === 2026-08-15T22:30 en Buenos Aires.
    expect(claveDiaArgentino(new Date("2026-08-16T01:30:00Z"))).toBe("2026-08-15");
  });

  it("las 00:30 ART siguen siendo el día que empezó", () => {
    expect(claveDiaArgentino(new Date("2026-08-16T03:30:00Z"))).toBe("2026-08-16");
  });

  it("las 02:00 UTC de un 1 de mes todavía son el último día del mes anterior", () => {
    expect(claveDiaArgentino(new Date("2026-09-01T02:00:00Z"))).toBe("2026-08-31");
  });
});

describe("inicioDelDiaArgentino", () => {
  it("devuelve el instante UTC de la medianoche de Buenos Aires", () => {
    // Se compara contra `Orden.createdAt`, que la base guarda en UTC: el
    // instante tiene que seguir siendo UTC válido, solo que el que corresponde a
    // la medianoche local y no a la de Greenwich.
    expect(inicioDelDiaArgentino("2026-08-15")).toEqual(new Date("2026-08-15T03:00:00.000Z"));
  });

  it("es la inversa exacta de claveDiaArgentino", () => {
    for (const clave of ["2026-01-01", "2026-08-15", "2026-12-31"]) {
      expect(claveDiaArgentino(inicioDelDiaArgentino(clave))).toBe(clave);
    }
  });

  it("devuelve null ante una clave ilegible, sin lanzar", () => {
    expect(inicioDelDiaArgentino("no-es-fecha")).toBeNull();
  });
});

describe("enHorarioArgentino", () => {
  it("aplica un desfase fijo de -3 horas, sin horario de verano", () => {
    expect(DESFASE_ARGENTINA_MS).toBe(-3 * 60 * 60 * 1000);
    // Enero (verano austral) y agosto (invierno) se desplazan igual: Argentina
    // no aplica DST desde 2009.
    expect(enHorarioArgentino(new Date("2026-01-10T12:00:00Z")).getUTCHours()).toBe(9);
    expect(enHorarioArgentino(new Date("2026-08-10T12:00:00Z")).getUTCHours()).toBe(9);
  });

  it("devuelve null ante un valor ausente o ilegible", () => {
    expect(enHorarioArgentino(null)).toBeNull();
    expect(enHorarioArgentino(undefined)).toBeNull();
    expect(enHorarioArgentino("cualquier cosa")).toBeNull();
  });
});
