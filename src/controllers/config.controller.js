import { estaDentroDeHorario } from "../lib/horarioAtencion.js";

const TEXTO_EN_HORARIO = "Te respondemos ahora";
const TEXTO_FUERA_DE_HORARIO = "Fuera de horario de atención — te respondemos apenas podamos";

export function whatsapp(_req, res) {
  const config = {
    horaDesde: Number(process.env.WHATSAPP_HORA_DESDE),
    horaHasta: Number(process.env.WHATSAPP_HORA_HASTA),
    dias: (process.env.WHATSAPP_DIAS ?? "")
      .split(",")
      .map((d) => Number(d.trim()))
      .filter((d) => !Number.isNaN(d)),
  };

  const dentroDeHorario = estaDentroDeHorario(config);

  res.json({
    numero: process.env.WHATSAPP_NUMERO,
    dentroDeHorario,
    textoHorario: dentroDeHorario ? TEXTO_EN_HORARIO : TEXTO_FUERA_DE_HORARIO,
  });
}
