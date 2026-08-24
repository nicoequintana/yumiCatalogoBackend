const TIMEZONE = "America/Argentina/Buenos_Aires";

/**
 * Devuelve { hora, diaSemana } de `fecha` en el horario de Argentina
 * (America/Argentina/Buenos_Aires, UTC-3, sin horario de verano), sin
 * depender del timezone local del proceso que corre el server.
 *
 * `diaSemana` usa la misma numeración que `Date.getDay()`: 0=domingo..6=sábado.
 *
 * @param {Date} fecha
 * @returns {{ hora: number, diaSemana: number }}
 */
function obtenerHoraYDiaEnArgentina(fecha) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    hour12: false,
    weekday: "short",
  });

  const partes = formatter.formatToParts(fecha);
  const horaParte = partes.find((p) => p.type === "hour").value;
  const diaParte = partes.find((p) => p.type === "weekday").value;

  // Intl puede devolver "24" para la medianoche en vez de "0" con hour12: false.
  const hora = Number(horaParte) % 24;

  const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const diaSemana = DIAS[diaParte];

  return { hora, diaSemana };
}

/**
 * Indica si `fecha` (por defecto, ahora) cae dentro del horario de atención
 * configurado, evaluado en horario de Argentina.
 *
 * El límite inferior (`horaDesde`) es inclusive, el superior (`horaHasta`)
 * es exclusivo: con horaDesde=9/horaHasta=18, las 18:00 en punto ya cuentan
 * como fuera de horario.
 *
 * @param {{ horaDesde: number, horaHasta: number, dias: number[] }} config
 * @param {Date} [fecha]
 * @returns {boolean}
 */
export function estaDentroDeHorario(config, fecha = new Date()) {
  const { horaDesde, horaHasta, dias } = config;
  const { hora, diaSemana } = obtenerHoraYDiaEnArgentina(fecha);

  if (!dias.includes(diaSemana)) return false;

  return hora >= horaDesde && hora < horaHasta;
}
