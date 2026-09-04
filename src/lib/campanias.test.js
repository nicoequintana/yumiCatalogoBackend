import { describe, expect, it } from "vitest";
import { inicioDelDiaArgentino } from "./horarioArgentino.js";
import {
  CTA_TEXTO_POR_DEFECTO,
  ESTADOS_CAMPANIA,
  ESTADOS_TEMPORALES,
  ETIQUETA_DESTINO_CTA,
  ETIQUETA_TIPO,
  TIPOS_CAMPANIA,
  TIPOS_DESTINO_CTA,
  elegirPorPrioridad,
  estadoTemporal,
  listaDeDestinosCta,
  listaDeEstadosCampania,
  listaDeTipos,
  resolverEstadoCampania,
} from "./campanias.js";

/**
 * Guard de la única fuente de verdad de "¿esta campaña está activa ahora?".
 *
 * La regla es de dos mitades que se multiplican: el estado que el admin eligió
 * a mano y el que sale de las fechas. Cada mitad por separado no dice nada, y
 * ese es justamente el error que este archivo existe para atrapar — una
 * campaña HABILITADA fuera de fecha y una campaña vigente puesta en OFF tienen
 * que dar las dos el mismo resultado: no activa.
 */

/** Instante ARGENTINO a partir de un día y una hora del reloj de Buenos Aires. */
function enArgentina(clave, horas = 0, minutos = 0, segundos = 0) {
  const medianoche = inicioDelDiaArgentino(clave).getTime();
  return new Date(medianoche + horas * 3_600_000 + minutos * 60_000 + segundos * 1000);
}

/** La campaña de referencia de toda la batería: 10/09 → 20/09, habilitada. */
function campaniaDePrueba(extra = {}) {
  return {
    id: 1,
    nombre: "Primavera",
    tipo: "ESTACIONAL",
    estado: "HABILITADA",
    desde: inicioDelDiaArgentino("2026-09-10"),
    hasta: inicioDelDiaArgentino("2026-09-20"),
    prioridad: 0,
    ...extra,
  };
}

describe("estadoTemporal — el período, sin mirar el estado manual", () => {
  it("el día anterior al inicio está PROGRAMADA", () => {
    expect(estadoTemporal(campaniaDePrueba(), enArgentina("2026-09-09", 12))).toBe("PROGRAMADA");
  });

  it("la medianoche del primer día ya está ACTIVA", () => {
    expect(estadoTemporal(campaniaDePrueba(), enArgentina("2026-09-10"))).toBe("ACTIVA");
  });

  it("un día del medio está ACTIVA", () => {
    expect(estadoTemporal(campaniaDePrueba(), enArgentina("2026-09-15", 15, 30))).toBe("ACTIVA");
  });

  it("el ÚLTIMO día sigue ACTIVA hasta las 23:59:59", () => {
    // El caso que el prompt pide explícitamente: una campaña que termina el 20
    // tiene que valer durante todo el 20, no apagarse a alguna hora del medio.
    expect(estadoTemporal(campaniaDePrueba(), enArgentina("2026-09-20", 23, 59, 59))).toBe("ACTIVA");
  });

  it("el último día a las 21:00 ART sigue ACTIVA aunque en UTC ya sea el día siguiente", () => {
    // Este es el guard de la trampa horaria. Las 21:00 del 20 en Buenos Aires
    // son las 00:00 UTC del 21: una comparación hecha con el día UTC apagaría
    // la campaña tres horas antes, justo en la franja en la que más se vende, y
    // nada lo delataría.
    const ultimaNoche = enArgentina("2026-09-20", 21, 30);
    expect(ultimaNoche.toISOString().slice(0, 10)).toBe("2026-09-21"); // en UTC ya es el 21

    expect(estadoTemporal(campaniaDePrueba(), ultimaNoche)).toBe("ACTIVA");
  });

  it("la medianoche del día siguiente al fin ya está FINALIZADA", () => {
    expect(estadoTemporal(campaniaDePrueba(), enArgentina("2026-09-21"))).toBe("FINALIZADA");
  });

  it("una campaña de un solo día vale todo ese día y ninguno más", () => {
    const navidad = campaniaDePrueba({
      desde: inicioDelDiaArgentino("2026-12-25"),
      hasta: inicioDelDiaArgentino("2026-12-25"),
    });

    expect(estadoTemporal(navidad, enArgentina("2026-12-24", 23, 59, 59))).toBe("PROGRAMADA");
    expect(estadoTemporal(navidad, enArgentina("2026-12-25"))).toBe("ACTIVA");
    expect(estadoTemporal(navidad, enArgentina("2026-12-25", 23, 59, 59))).toBe("ACTIVA");
    expect(estadoTemporal(navidad, enArgentina("2026-12-26"))).toBe("FINALIZADA");
  });

  it("acepta las fechas como string, no solo como Date", () => {
    // Prisma devuelve Date, pero un payload que dio la vuelta por JSON trae
    // string. Las dos formas tienen que dar el mismo veredicto.
    const comoTexto = campaniaDePrueba({
      desde: inicioDelDiaArgentino("2026-09-10").toISOString(),
      hasta: inicioDelDiaArgentino("2026-09-20").toISOString(),
    });

    expect(estadoTemporal(comoTexto, enArgentina("2026-09-15"))).toBe("ACTIVA");
  });
});

describe("resolverEstadoCampania — las dos mitades juntas", () => {
  it("HABILITADA y dentro del período: activa", () => {
    const resuelto = resolverEstadoCampania(campaniaDePrueba(), enArgentina("2026-09-15"));

    expect(resuelto.manual).toBe("HABILITADA");
    expect(resuelto.temporal).toBe("ACTIVA");
    expect(resuelto.activa).toBe(true);
  });

  it("el OFF manual apaga una campaña que está en fecha", () => {
    // El requisito del prompt: estoy adentro del período, la pongo en OFF, y
    // deja de producir CUALQUIER efecto en el acto.
    const resuelto = resolverEstadoCampania(
      campaniaDePrueba({ estado: "DESHABILITADA" }),
      enArgentina("2026-09-15"),
    );

    expect(resuelto.temporal).toBe("ACTIVA"); // el período no cambió
    expect(resuelto.activa).toBe(false); // pero no produce nada
  });

  it("el ON manual NO fuerza una activación fuera de fecha", () => {
    const resuelto = resolverEstadoCampania(campaniaDePrueba(), enArgentina("2026-09-25"));

    expect(resuelto.manual).toBe("HABILITADA");
    expect(resuelto.temporal).toBe("FINALIZADA");
    expect(resuelto.activa).toBe(false);
  });

  it("un BORRADOR nunca está activo, aunque esté en fecha", () => {
    const resuelto = resolverEstadoCampania(
      campaniaDePrueba({ estado: "BORRADOR" }),
      enArgentina("2026-09-15"),
    );

    expect(resuelto.activa).toBe(false);
  });

  it("emite las etiquetas legibles, para que el admin no arme su propio diccionario", () => {
    const resuelto = resolverEstadoCampania(campaniaDePrueba(), enArgentina("2026-09-15"));

    expect(resuelto.etiquetaEstado).toBe("Habilitada");
    expect(resuelto.etiquetaTemporal).toBe("Activa");
  });

  it("un estado desconocido no rompe: cae a no activa y se etiqueta con su clave", () => {
    // Una migración a medio aplicar o un dato viejo tiene que salir feo pero
    // legible, nunca como `undefined` en la pantalla ni como un throw.
    const resuelto = resolverEstadoCampania(
      campaniaDePrueba({ estado: "PAUSADA_2024" }),
      enArgentina("2026-09-15"),
    );

    expect(resuelto.activa).toBe(false);
    expect(resuelto.etiquetaEstado).toBe("PAUSADA_2024");
  });
});

describe("los diccionarios que consume el panel", () => {
  it("listaDeTipos emite valor + etiqueta de los seis tipos", () => {
    // Es la fuente del <select> del formulario. Sin esto el frontend tiene que
    // copiar la lista a mano, y agregar un tipo pasa a tocarse en dos lugares:
    // el backend lo acepta y el panel no lo ofrece, sin ningún test rojo.
    const tipos = listaDeTipos();

    expect(tipos).toHaveLength(TIPOS_CAMPANIA.length);
    expect(tipos[0]).toEqual({ valor: "ESTACIONAL", etiqueta: "Estacional" });
  });

  it("listaDeEstadosCampania emite valor + etiqueta de los tres estados", () => {
    expect(listaDeEstadosCampania()).toEqual([
      { valor: "BORRADOR", etiqueta: "Borrador" },
      { valor: "HABILITADA", etiqueta: "Habilitada" },
      { valor: "DESHABILITADA", etiqueta: "Deshabilitada" },
    ]);
  });

  it("devuelven objetos NUEVOS en cada llamada", () => {
    // El resultado viaja a serialización y a pantallas que podrían mutarlo; un
    // llamador descuidado no puede envenenar la fuente para el resto del
    // proceso. Mismo criterio que `listaDeEstados` en estadosOrden.js.
    expect(listaDeTipos()[0]).not.toBe(listaDeTipos()[0]);
  });

  it("listaDeDestinosCta emite valor + etiqueta de los cuatro destinos", () => {
    // Es la fuente del `<select>` de "¿a dónde lleva el botón?". El panel no
    // tiene copia: sin este diccionario, agregar un destino se toca en dos
    // lugares y el modo de falla es MUDO — el backend lo acepta y el
    // formulario no lo ofrece.
    const destinos = listaDeDestinosCta();

    expect(destinos).toHaveLength(TIPOS_DESTINO_CTA.length);
    expect(destinos).toEqual([
      { valor: "CAMPANIA", etiqueta: "Los productos de la campaña" },
      { valor: "CATALOGO", etiqueta: "Todo el catálogo" },
      { valor: "CATEGORIA", etiqueta: "Una categoría" },
      { valor: "PRODUCTO", etiqueta: "Un producto" },
    ]);
  });

  it("listaDeDestinosCta devuelve objetos NUEVOS en cada llamada", () => {
    expect(listaDeDestinosCta()[0]).not.toBe(listaDeDestinosCta()[0]);
  });

  it("TODO destino tiene etiqueta, y no hay etiquetas sobrantes", () => {
    expect(Object.keys(ETIQUETA_DESTINO_CTA).sort()).toEqual([...TIPOS_DESTINO_CTA].sort());
  });

  it("el texto por defecto del botón es un string no vacío", () => {
    // Viaja al panel por `GET /campanias/opciones` para que el placeholder del
    // editor NO sea una copia manual de este string.
    expect(CTA_TEXTO_POR_DEFECTO).toBe("Ver más");
  });
});

describe("elegirPorPrioridad — el recurso visual que solo admite uno", () => {
  it("gana la prioridad más alta", () => {
    const a = campaniaDePrueba({ id: 1, prioridad: 10 });
    const b = campaniaDePrueba({ id: 2, prioridad: 20 });

    expect(elegirPorPrioridad([a, b])?.id).toBe(2);
    expect(elegirPorPrioridad([b, a])?.id).toBe(2); // el orden de entrada no decide
  });

  it("con la misma prioridad desempata el id más alto", () => {
    // Mismo criterio que el resto del repo: sin desempate explícito, dos
    // consultas podrían devolver doodles distintos para el mismo instante.
    const vieja = campaniaDePrueba({ id: 3, prioridad: 5 });
    const nueva = campaniaDePrueba({ id: 7, prioridad: 5 });

    expect(elegirPorPrioridad([vieja, nueva])?.id).toBe(7);
  });

  it("sin candidatas devuelve null, nunca undefined", () => {
    expect(elegirPorPrioridad([])).toBeNull();
    expect(elegirPorPrioridad(undefined)).toBeNull();
  });
});

describe("las listas canónicas", () => {
  it("los tipos son los seis del modelo", () => {
    expect(TIPOS_CAMPANIA).toEqual([
      "ESTACIONAL",
      "EVENTO_COMERCIAL",
      "FECHA_ESPECIAL",
      "PROMOCIONAL",
      "INSTITUCIONAL",
      "OTRO",
    ]);
  });

  it("los estados administrativos son tres y los temporales otros tres", () => {
    expect(ESTADOS_CAMPANIA).toEqual(["BORRADOR", "HABILITADA", "DESHABILITADA"]);
    expect(ESTADOS_TEMPORALES).toEqual(["PROGRAMADA", "ACTIVA", "FINALIZADA"]);
  });

  it("TODO tipo tiene etiqueta, y no hay etiquetas sobrantes", () => {
    // `ETIQUETA_TIPO` era código muerto: existía la casa única, estaba vacía, y
    // el formulario del panel usaba una copia hecha a mano. Este test es lo que
    // mantiene los dos diccionarios pegados.
    expect(Object.keys(ETIQUETA_TIPO).sort()).toEqual([...TIPOS_CAMPANIA].sort());
  });

  it("los estados administrativos y los temporales no comparten ningún valor", () => {
    // Si compartieran uno, un bug de tipeo podría cruzar las dos dimensiones
    // sin que nada falle: son ejes distintos y tienen que verse distintos.
    const cruce = ESTADOS_CAMPANIA.filter((estado) => ESTADOS_TEMPORALES.includes(estado));

    expect(cruce).toEqual([]);
  });
});
