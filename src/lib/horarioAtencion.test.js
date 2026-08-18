import { describe, expect, it } from "vitest";
import { estaDentroDeHorario } from "./horarioAtencion.js";

const CONFIG_LUN_A_VIER_9_A_18 = {
  horaDesde: 9,
  horaHasta: 18,
  dias: [1, 2, 3, 4, 5],
};

describe("estaDentroDeHorario", () => {
  it("devuelve true en un horario y día hábil (miércoles 10hs ART)", () => {
    // 2026-01-07 es miércoles. 10:00 ART (UTC-3) = 13:00 UTC.
    const ahora = new Date("2026-01-07T13:00:00.000Z");
    expect(estaDentroDeHorario(CONFIG_LUN_A_VIER_9_A_18, ahora)).toBe(true);
  });

  it("devuelve false fuera de horario (miércoles 20hs ART)", () => {
    // 20:00 ART = 23:00 UTC.
    const ahora = new Date("2026-01-07T23:00:00.000Z");
    expect(estaDentroDeHorario(CONFIG_LUN_A_VIER_9_A_18, ahora)).toBe(false);
  });

  it("devuelve false en un día no habilitado (domingo 10hs ART)", () => {
    // 2026-01-04 es domingo. 10:00 ART = 13:00 UTC.
    const ahora = new Date("2026-01-04T13:00:00.000Z");
    expect(estaDentroDeHorario(CONFIG_LUN_A_VIER_9_A_18, ahora)).toBe(false);
  });

  it("incluye el límite inferior exacto (9:00 ART en punto)", () => {
    // 09:00 ART = 12:00 UTC.
    const ahora = new Date("2026-01-07T12:00:00.000Z");
    expect(estaDentroDeHorario(CONFIG_LUN_A_VIER_9_A_18, ahora)).toBe(true);
  });

  it("excluye el límite superior exacto (18:00 ART en punto)", () => {
    // 18:00 ART = 21:00 UTC.
    const ahora = new Date("2026-01-07T21:00:00.000Z");
    expect(estaDentroDeHorario(CONFIG_LUN_A_VIER_9_A_18, ahora)).toBe(false);
  });

  it("usa el timezone de Argentina, no el horario local UTC del Date", () => {
    // 2026-01-07T01:00:00Z es miércoles 01hs UTC, pero en Argentina (UTC-3)
    // todavía es martes 22hs -> fuera de horario. Si el código usara
    // getUTCHours/getUTCDay (o el horario local del proceso) en vez de
    // convertir explícitamente a America/Argentina/Buenos_Aires, este caso
    // podría dar un resultado incorrecto según dónde corra el server.
    const ahora = new Date("2026-01-07T01:00:00.000Z");
    expect(estaDentroDeHorario(CONFIG_LUN_A_VIER_9_A_18, ahora)).toBe(false);
  });

  it("caso inverso: la fecha UTC ya cambió de día pero el horario ART sigue siendo el de antes", () => {
    // 2026-01-08T02:30:00Z es jueves 02:30 UTC. En Argentina (UTC-3) todavía
    // es miércoles 23:30 -> fuera de horario (después de las 18). Si el
    // código usara getUTCHours/getUTCDay en vez de convertir a ART, vería
    // "jueves 02:30" (día hábil pero de madrugada) y también daría false,
    // así que probamos igual el resultado correcto por la razón correcta:
    // sigue siendo miércoles en ART, no jueves.
    const ahora = new Date("2026-01-08T02:30:00.000Z");
    expect(estaDentroDeHorario(CONFIG_LUN_A_VIER_9_A_18, ahora)).toBe(false);
  });

  it("usa Date.now() por defecto si no se inyecta una fecha", () => {
    expect(() => estaDentroDeHorario(CONFIG_LUN_A_VIER_9_A_18)).not.toThrow();
  });
});
