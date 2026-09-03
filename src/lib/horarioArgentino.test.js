import { describe, expect, it } from "vitest";
import {
  DESFASE_ARGENTINA_MS,
  claveDiaArgentino,
  diasHastaClave,
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

describe("diasHastaClave — el contador de los modales de campaña", () => {
  /** Un instante ARGENTINO a partir de un día y una hora del reloj local. */
  function enArgentina(clave, horas = 0) {
    return new Date(inicioDelDiaArgentino(clave).getTime() + horas * 3_600_000);
  }

  it("cuenta días ARGENTINOS, no diferencias de instantes", () => {
    expect(diasHastaClave("2026-09-21", enArgentina("2026-09-03"))).toBe(18);
  });

  it("el mismo día da CERO, no uno", () => {
    // "Faltan 0 días para la Primavera" es lo que permite que la pantalla diga
    // "¡Es hoy!". Un 1 acá le erraría al día entero.
    expect(diasHastaClave("2026-09-21", enArgentina("2026-09-21"))).toBe(0);
  });

  it("sigue dando CERO a las 23:59 del día objetivo", () => {
    // Es día completo, no un instante: hasta que no pasa la medianoche
    // argentina, sigue siendo hoy.
    expect(diasHastaClave("2026-09-21", enArgentina("2026-09-21", 23))).toBe(0);
  });

  it("a las 21:00 de la víspera todavía falta UNO, aunque en UTC ya sea el día", () => {
    // La trampa horaria de siempre: las 21:00 del 20 en Buenos Aires son las
    // 00:00 UTC del 21. Con aritmética sobre instantes UTC, el contador se
    // adelantaría un día cada noche, que es cuando más gente mira el sitio.
    const vispera = enArgentina("2026-09-20", 21);
    expect(vispera.toISOString().slice(0, 10)).toBe("2026-09-21");

    expect(diasHastaClave("2026-09-21", vispera)).toBe(1);
  });

  it("una fecha que ya pasó da un número NEGATIVO, no cero", () => {
    // Cero significaría "es hoy" y sería mentira. Quien consuma esto decide qué
    // hacer con un negativo; taparlo acá le sacaría la información.
    expect(diasHastaClave("2026-09-01", enArgentina("2026-09-03"))).toBe(-2);
  });

  it("cruza meses y años sin contar de más", () => {
    expect(diasHastaClave("2026-10-01", enArgentina("2026-09-30"))).toBe(1);
    expect(diasHastaClave("2027-01-01", enArgentina("2026-12-25"))).toBe(7);
  });

  it("una clave ilegible devuelve null en vez de un número inventado", () => {
    expect(diasHastaClave("25/12/2026", enArgentina("2026-09-03"))).toBeNull();
    expect(diasHastaClave(null, enArgentina("2026-09-03"))).toBeNull();
    expect(diasHastaClave(undefined, enArgentina("2026-09-03"))).toBeNull();
  });
});
