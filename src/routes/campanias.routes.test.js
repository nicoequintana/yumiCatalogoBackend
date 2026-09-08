import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";
import { inicioDelDiaArgentino } from "../lib/horarioArgentino.js";

process.env.JWT_SECRET = "test-secret";

const campaniaMock = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
};
const promocionFindManyMock = vi.fn();
const campaniaPromocionMock = { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() };
const campaniaProductoMock = {
  deleteMany: vi.fn(),
  createMany: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
};
const productMock = { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() };
const categoriaMock = { findUnique: vi.fn() };
const transactionMock = vi.fn();
const usuarioFindUniqueMock = vi.fn();
const auditCreateMock = vi.fn();
const subirArchivoMock = vi.fn();
const eliminarArchivoMock = vi.fn();
const eventoTraficoCreateMock = vi.fn();

vi.mock("../services/cloudinary.service.js", () => ({
  subirArchivo: (...args) => subirArchivoMock(...args),
  eliminarArchivo: (...args) => eliminarArchivoMock(...args),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    campania: {
      findMany: (...args) => campaniaMock.findMany(...args),
      findUnique: (...args) => campaniaMock.findUnique(...args),
      create: (...args) => campaniaMock.create(...args),
      update: (...args) => campaniaMock.update(...args),
      delete: (...args) => campaniaMock.delete(...args),
      count: (...args) => campaniaMock.count(...args),
    },
    promocion: { findMany: (...a) => promocionFindManyMock(...a) },
    product: {
      findMany: (...a) => productMock.findMany(...a),
      findUnique: (...a) => productMock.findUnique(...a),
      count: (...a) => productMock.count(...a),
    },
    categoria: { findUnique: (...a) => categoriaMock.findUnique(...a) },
    campaniaPromocion: {
      deleteMany: (...a) => campaniaPromocionMock.deleteMany(...a),
      createMany: (...a) => campaniaPromocionMock.createMany(...a),
      findMany: (...a) => campaniaPromocionMock.findMany(...a),
    },
    campaniaProducto: {
      deleteMany: (...a) => campaniaProductoMock.deleteMany(...a),
      createMany: (...a) => campaniaProductoMock.createMany(...a),
      findMany: (...a) => campaniaProductoMock.findMany(...a),
      count: (...a) => campaniaProductoMock.count(...a),
    },
    $transaction: (...a) => transactionMock(...a),
    usuario: { findUnique: (...args) => usuarioFindUniqueMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    eventoTrafico: { create: (...a) => eventoTraficoCreateMock(...a) },
  },
}));

const { default: campaniasRouter } = await import("./campanias.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/campanias", campaniasRouter);
  // El error handler REAL, no uno improvisado: un test que afirme un cuerpo de
  // error contra un handler de mentira puede pasar mientras producción manda otra cosa.
  app.use(manejadorDeErrores);
  return app;
}

// El token se firma con el reloj REAL, pero la suite adelanta el sistema a una
// fecha fija para poder afirmar sobre la vigencia de las campañas. Con la
// expiración habitual de 7 días, ese salto deja el JWT vencido y todas las
// rutas con auth responden 401 — un 401 que no dice nada del código bajo
// prueba. La expiración larga es lo que separa las dos cosas.
const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "3650d",
});
const authHeader = `Bearer ${token}`;

/** Estamos parados el 15/09/2026 a las 10:00 de Buenos Aires. */
const HOY = new Date(inicioDelDiaArgentino("2026-09-15").getTime() + 10 * 3_600_000);

function fila(extra = {}) {
  return {
    id: 1,
    nombre: "Primavera",
    descripcion: "Nota interna que no sale al público",
    tipo: "ESTACIONAL",
    estado: "HABILITADA",
    desde: inicioDelDiaArgentino("2026-09-10"),
    hasta: inicioDelDiaArgentino("2026-09-20"),
    prioridad: 0,
    doodleUrl: "https://res.cloudinary.com/demo/doodle.png",
    doodleCloudinaryPublicId: "campanias/doodle",
    doodleCloudinaryResourceType: "image",
    doodleEnCatalogo: true,
    doodleEnAdmin: false,
    modalActivo: false,
    modalTitulo: null,
    modalTexto: null,
    modalCtaTexto: null,
    modalCtaTipo: null,
    modalCtaReferenciaId: null,
    modalFechaObjetivo: null,
    // Última red antes de que `curl` contra la base real confirme la columna:
    // sin estos defaults, un mapper que se olvida de leerlos pasaría en verde
    // igual porque el mock nunca los trae de entrada.
    bannerEnHome: false,
    bannerTitulo: null,
    bannerTexto: null,
    // `bannerCtaTexto` y `bannerColor` SIGUEN en el fixture aunque nadie los
    // lea: la columna existe en la base y el mock tiene que parecerse a la
    // fila real, o los guards de "no se emiten" probarían contra un objeto que
    // nunca los tuvo — un test que no puede fallar cuando la regla se rompe.
    bannerCtaTexto: null,
    // Las tres columnas del arte: mismo criterio que el resto del fixture,
    // agregadas con el carrusel de la Task 5.
    bannerArteUrl: null,
    bannerArteCloudinaryPublicId: null,
    bannerArteCloudinaryResourceType: null,
    bannerColor: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    // El listado lo pide con `include`, así que Prisma SIEMPRE lo devuelve ahí.
    // Va en el fixture base a propósito: las filas de crear/actualizar tampoco
    // lo tendrían en producción, y tenerlo acá deja probado que `mapCampania`
    // lo IGNORA en vez de filtrar un cero falso.
    _count: { productos: 0 },
    ...extra,
  };
}

/** Una campaña con el modal prendido y su contador apuntando al 21/09. */
function conModal(extra = {}) {
  return fila({
    modalActivo: true,
    modalTitulo: "Llega la primavera",
    modalTexto: "Faltan {dias} días para la Primavera.",
    modalCtaTexto: "Ver la selección",
    modalCtaTipo: "CATALOGO",
    modalFechaObjetivo: inicioDelDiaArgentino("2026-09-21"),
    ...extra,
  });
}

/**
 * Una fila de producto tal como la trae la vitrina: envuelta en la fila de
 * `CampaniaProducto`, con la portada ya recortada a una foto.
 *
 * `precio` se finge con un `toString` propio y NO con un número: un mapper que
 * se olvide de serializarlo emitiría el objeto crudo, que en JSON sale `{}` —
 * con un número el test pasaría igual y dejaría de poder atrapar el bug.
 */
function enVitrina(producto = {}) {
  return {
    product: {
      id: 7,
      nombre: "Termo Stanley",
      sku: "YIMA-0007",
      precio: { toString: () => "48000" },
      visibleEnCatalogo: true,
      stock: 5,
      fotos: [{ id: 11, url: "https://res.cloudinary.com/demo/termo.webp" }],
      ...producto,
    },
  };
}

/** La campaña como la devuelve el detalle: con sus dos relaciones cargadas. */
function conDetalle({ productos = [], promociones = [], ...extra } = {}) {
  return fila({ productos, promociones, ...extra });
}

beforeEach(() => {
  // Se faquea SOLO `Date`. Lo que esta suite necesita controlar es qué día es,
  // no el event loop: con los timers de Node también faqueados, el servidor
  // HTTP real que levanta supertest se queda esperando un tick que nunca llega
  // y el test muere por timeout en vez de fallar por lo que afirma.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(HOY);
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
  eventoTraficoCreateMock.mockReset();
  campaniaMock.findMany.mockResolvedValue([]);
  promocionFindManyMock.mockResolvedValue([]);
  campaniaPromocionMock.findMany.mockResolvedValue([]);
  campaniaProductoMock.findMany.mockResolvedValue([]);
  campaniaProductoMock.deleteMany.mockResolvedValue({ count: 0 });
  campaniaProductoMock.createMany.mockResolvedValue({ count: 0 });
  // La vitrina arranca VACÍA: el default del `count` es 0 para que el destino
  // CAMPANIA caiga en `/coleccion` salvo que un test diga lo contrario.
  campaniaProductoMock.count.mockResolvedValue(0);
  productMock.findMany.mockResolvedValue([]);
  // Sin ofertas por defecto: el slide automático solo aparece cuando un test
  // dice explícitamente que hay productos con descuento.
  productMock.count.mockResolvedValue(0);
  // Las referencias del CTA arrancan INEXISTENTES: así, un test que espere que
  // el destino resuelva tiene que decir explícitamente qué hay del otro lado.
  productMock.findUnique.mockResolvedValue(null);
  categoriaMock.findUnique.mockResolvedValue(null);
  // El `tx` se arma a mano: sólo expone lo que los controllers usan adentro de
  // la transacción. Un delegado que falte sale como "no es una función", que es
  // más claro que un mock automático que devuelve `undefined` en silencio.
  transactionMock.mockImplementation(async (arg) =>
    typeof arg === "function"
      ? arg({
          campania: { create: (...a) => campaniaMock.create(...a) },
          campaniaPromocion: {
            deleteMany: (...a) => campaniaPromocionMock.deleteMany(...a),
            createMany: (...a) => campaniaPromocionMock.createMany(...a),
          },
          campaniaProducto: {
            deleteMany: (...a) => campaniaProductoMock.deleteMany(...a),
            createMany: (...a) => campaniaProductoMock.createMany(...a),
            findMany: (...a) => campaniaProductoMock.findMany(...a),
          },
        })
      : Promise.all(arg),
  );
  campaniaMock.count.mockResolvedValue(0);
  subirArchivoMock.mockResolvedValue({
    url: "https://res.cloudinary.com/demo/nuevo.png",
    cloudinaryPublicId: "campanias/nuevo",
    cloudinaryResourceType: "image",
  });
  eliminarArchivoMock.mockResolvedValue(undefined);
});

/** Un PNG mínimo: la firma real, para que `contenidoCoincideConMime` lo acepte. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64),
]);

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/campanias/activas — el contexto comercial del catálogo público", () => {
  it("sin ninguna campaña responde el contexto vacío, no un 404", () => {
    // El catálogo pide esto en cada carga de página. "No hay nada" es una
    // respuesta legítima y tiene que ser barata de manejar en el frontend.
    campaniaMock.findMany.mockResolvedValue([]);

    return request(buildApp())
      .get("/api/campanias/activas")
      .expect(200)
      .then((res) => {
        expect(res.body.doodle).toBeNull();
        expect(res.body.claveDia).toBe("2026-09-15");
      });
  });

  it("emite el doodle de la campaña activa", async () => {
    campaniaMock.findMany.mockResolvedValue([fila()]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.status).toBe(200);
    expect(res.body.doodle).toEqual({
      url: "https://res.cloudinary.com/demo/doodle.png",
      campaniaId: 1,
      nombre: "Primavera",
    });
  });

  it("NUNCA filtra datos internos de la campaña", async () => {
    // Es un endpoint público sin token. La descripción es una nota del panel y
    // el publicId de Cloudinary es infraestructura: ninguno de los dos tiene
    // por qué viajar al bundle que cualquiera lee.
    campaniaMock.findMany.mockResolvedValue([fila()]);

    const res = await request(buildApp()).get("/api/campanias/activas");
    const serializado = JSON.stringify(res.body);

    expect(serializado).not.toContain("Nota interna");
    expect(serializado).not.toContain("campanias/doodle");
    expect(serializado).not.toContain("prioridad");
    expect(serializado).not.toContain("HABILITADA");
  });

  it("una campaña DESHABILITADA no aporta doodle aunque esté en fecha", async () => {
    // El OFF manual tiene que apagar en el acto. La consulta ya filtra por
    // estado, pero el veredicto final lo da `resolverEstadoCampania`: si algún
    // día la consulta se afloja, esto sigue siendo la red.
    campaniaMock.findMany.mockResolvedValue([fila({ estado: "DESHABILITADA" })]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.doodle).toBeNull();
  });

  it("una campaña vencida no aporta doodle aunque la consulta la devuelva", async () => {
    campaniaMock.findMany.mockResolvedValue([
      fila({
        desde: inicioDelDiaArgentino("2026-08-01"),
        hasta: inicioDelDiaArgentino("2026-08-31"),
      }),
    ]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.doodle).toBeNull();
  });

  it("con doodleEnCatalogo en false no aporta doodle al público", async () => {
    campaniaMock.findMany.mockResolvedValue([fila({ doodleEnCatalogo: false })]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.doodle).toBeNull();
  });

  it("una campaña activa SIN doodle deja el logo normal", async () => {
    campaniaMock.findMany.mockResolvedValue([
      fila({ doodleUrl: null, doodleCloudinaryPublicId: null }),
    ]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.doodle).toBeNull();
  });

  it("SIN token no emite el doodle del panel", async () => {
    // `doodleEnAdmin` es una decisión interna: una campaña puede querer marca
    // festiva puertas adentro y no de cara al cliente. Emitir ese doodle a un
    // anónimo filtraría justamente la intención que el flag expresa.
    campaniaMock.findMany.mockResolvedValue([
      fila({ doodleEnCatalogo: false, doodleEnAdmin: true }),
    ]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.doodle).toBeNull();
    expect(res.body).not.toHaveProperty("doodleAdmin");
  });

  it("CON token emite además el doodle del panel", async () => {
    // Mismo criterio que `GET /anuncios` y `GET /products`: quién ve qué lo
    // decide el TOKEN, nunca la querystring.
    campaniaMock.findMany.mockResolvedValue([
      fila({ doodleEnCatalogo: false, doodleEnAdmin: true }),
    ]);

    const res = await request(buildApp())
      .get("/api/campanias/activas")
      .set("Authorization", authHeader);

    expect(res.body.doodle).toBeNull();
    expect(res.body.doodleAdmin).toMatchObject({ campaniaId: 1 });
  });

  it("el doodle del catálogo y el del panel pueden ser campañas DISTINTAS", async () => {
    campaniaMock.findMany.mockResolvedValue([
      fila({ id: 1, doodleEnCatalogo: true, doodleEnAdmin: false, prioridad: 5 }),
      fila({ id: 2, doodleEnCatalogo: false, doodleEnAdmin: true, prioridad: 5 }),
    ]);

    const res = await request(buildApp())
      .get("/api/campanias/activas")
      .set("Authorization", authHeader);

    expect(res.body.doodle.campaniaId).toBe(1);
    expect(res.body.doodleAdmin.campaniaId).toBe(2);
  });

  it("con token y sin ninguna campaña para el panel, doodleAdmin es null", async () => {
    campaniaMock.findMany.mockResolvedValue([fila({ doodleEnAdmin: false })]);

    const res = await request(buildApp())
      .get("/api/campanias/activas")
      .set("Authorization", authHeader);

    expect(res.body.doodleAdmin).toBeNull();
  });

  it("un token vencido degrada a anónimo en vez de cortar con 401", async () => {
    // Es un endpoint público: "no pude probar quién sos" y "sos anónimo" tienen
    // que ser la misma respuesta. Con 401 acá, una sesión de admin vencida
    // rompería el logo del catálogo.
    const vencido = jwt.sign({ sub: 1, email: "x@y.z", tokenVersion: 0 }, "test-secret", {
      expiresIn: "-1h",
    });
    campaniaMock.findMany.mockResolvedValue([fila()]);

    const res = await request(buildApp())
      .get("/api/campanias/activas")
      .set("Authorization", `Bearer ${vencido}`);

    expect(res.status).toBe(200);
    expect(res.body.doodle.campaniaId).toBe(1);
  });

  it("entre dos doodles activos gana la prioridad más alta", async () => {
    campaniaMock.findMany.mockResolvedValue([
      fila({ id: 1, nombre: "Primavera", prioridad: 10 }),
      fila({ id: 2, nombre: "Día del Padre", prioridad: 20, doodleUrl: "https://res.cloudinary.com/demo/padre.png" }),
    ]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.doodle.campaniaId).toBe(2);
  });
});

describe("GET /api/campanias/activas — el modal", () => {
  it("emite el modal con el contador YA RESUELTO", async () => {
    // El cálculo lo hace el BACKEND, que es el único que tiene la definición de
    // "día" del sistema. Si contara el frontend, el número dependería del reloj
    // del visitante: alguien con la máquina mal puesta vería otro número.
    campaniaMock.findMany.mockResolvedValue([conModal()]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.modal).toMatchObject({
      titulo: "Llega la primavera",
      texto: "Faltan {dias} días para la Primavera.",
      ctaTexto: "Ver la selección",
      ctaDestino: "/coleccion",
      // Estamos parados el 15/09 y el objetivo es el 21/09.
      diasFaltantes: 6,
      campaniaId: 1,
    });
  });

  it("el modal lleva el Doodle de SU campaña, para que el cartel se identifique", async () => {
    // El cartel es la cara de la campaña: sin su arte arriba, un modal
    // estacional es un texto suelto sobre el catálogo.
    campaniaMock.findMany.mockResolvedValue([
      conModal({ doodleUrl: "https://res.cloudinary.com/demo/primavera.png" }),
    ]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.modal.doodleUrl).toBe("https://res.cloudinary.com/demo/primavera.png");
  });

  it("el Doodle del modal sale de la campaña del MODAL, no de la que manda el logo", async () => {
    // Los dos recursos se resuelven APARTE y pueden caer en campañas distintas.
    // Tomar el del header le pondría al cartel el arte de otra campaña: quien
    // mira vería el logo de una y el título de la otra, sin ningún error.
    campaniaMock.findMany.mockResolvedValue([
      fila({ id: 1, prioridad: 99, doodleUrl: "https://res.cloudinary.com/demo/logo.png" }),
      conModal({ id: 2, prioridad: 1, doodleUrl: null }),
    ]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.doodle.url).toBe("https://res.cloudinary.com/demo/logo.png");
    expect(res.body.modal.doodleUrl).toBeNull();
  });

  it("un modal sin Doodle emite la clave en null, no ausente", async () => {
    // `undefined` desaparece al serializar a JSON y la pantalla no puede
    // distinguir "esta campaña no tiene arte" de "me olvidé de mandarlo".
    campaniaMock.findMany.mockResolvedValue([conModal({ doodleUrl: null })]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.modal).toHaveProperty("doodleUrl", null);
  });

  it("sin fecha objetivo el contador es null, no cero", async () => {
    // Cero significaría "es hoy" y sería mentira. El modal sin contador es un
    // caso legítimo: no todo cartel cuenta días.
    campaniaMock.findMany.mockResolvedValue([conModal({ modalFechaObjetivo: null })]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.modal.diasFaltantes).toBeNull();
  });

  it("con el modal apagado no emite modal, aunque la campaña esté activa", async () => {
    // Es el caso de una campaña que solo quiere su Doodle: el modal interrumpe,
    // y prenderlo tiene que ser una decisión aparte.
    campaniaMock.findMany.mockResolvedValue([conModal({ modalActivo: false })]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.modal).toBeNull();
  });

  it("una campaña DESHABILITADA no muestra su modal", async () => {
    campaniaMock.findMany.mockResolvedValue([conModal({ estado: "DESHABILITADA" })]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.modal).toBeNull();
  });

  it("una campaña fuera de fecha no muestra su modal", async () => {
    campaniaMock.findMany.mockResolvedValue([
      conModal({
        desde: inicioDelDiaArgentino("2026-08-01"),
        hasta: inicioDelDiaArgentino("2026-08-31"),
      }),
    ]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.modal).toBeNull();
  });

  it("entre dos modales activos gana la prioridad más alta", async () => {
    // El modal es un recurso exclusivo igual que el logo: no se pueden apilar
    // dos carteles encima del catálogo.
    campaniaMock.findMany.mockResolvedValue([
      conModal({ id: 1, prioridad: 10, modalTitulo: "Primavera" }),
      conModal({ id: 2, prioridad: 30, modalTitulo: "Día del Padre" }),
    ]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.modal.campaniaId).toBe(2);
  });

  it("el modal NO filtra datos internos de la campaña", async () => {
    campaniaMock.findMany.mockResolvedValue([conModal()]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(JSON.stringify(res.body)).not.toContain("Nota interna");
    expect(res.body.modal).not.toHaveProperty("estado");
    expect(res.body.modal).not.toHaveProperty("prioridad");
  });

  it("el modal trae ctaTipo, y null cuando la campaña no tiene botón", async () => {
    // Mismo armado que el test vecino de arriba (`conModal`), con la intención
    // del CTA explícita.
    campaniaMock.findMany.mockResolvedValue([conModal({ modalCtaTipo: "CAMPANIA" })]);

    const res = await request(buildApp()).get("/api/campanias/activas");
    expect(res.body.modal.ctaTipo).toBe("CAMPANIA");

    campaniaMock.findMany.mockResolvedValue([conModal({ modalCtaTipo: null })]);
    const sinBoton = await request(buildApp()).get("/api/campanias/activas");
    expect(sinBoton.body.modal.ctaTipo).toBeNull();
    expect(sinBoton.body.modal.ctaDestino).toBeNull();
  });

  it("el Doodle y el modal pueden venir de campañas DISTINTAS", async () => {
    // Son dos recursos exclusivos independientes: la campaña que manda el logo
    // no tiene por qué ser la que manda el cartel.
    campaniaMock.findMany.mockResolvedValue([
      fila({ id: 1, prioridad: 50, doodleEnCatalogo: true }),
      conModal({ id: 2, prioridad: 10, doodleUrl: null }),
    ]);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.doodle.campaniaId).toBe(1);
    expect(res.body.modal.campaniaId).toBe(2);
  });
});

describe("GET /campanias/activas — slides", () => {
  it("emite un slide por campaña con banner, ordenados por prioridad", async () => {
    campaniaMock.findMany.mockResolvedValue([
      fila({ id: 1, prioridad: 1, bannerEnHome: true, bannerTitulo: "Primavera" }),
      fila({ id: 2, prioridad: 9, bannerEnHome: true, bannerTitulo: "Semana del Hogar" }),
    ]);
    productMock.count.mockResolvedValue(0);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body).not.toHaveProperty("banner");
    expect(res.body.slides.map((s) => s.titulo)).toEqual(["Semana del Hogar", "Primavera"]);
    expect(res.body.slides[0].tipo).toBe("CAMPANIA");
  });

  it("el slide de una campaña trae ctaTipo (la INTENCIÓN) y promocionId null EXPLÍCITO", async () => {
    // Mismo armado que el test vecino de arriba: una campaña con banner. Le
    // suma la intención del CTA (`modalCtaTipo`), que el slide reusa del cartel.
    campaniaMock.findMany.mockResolvedValue([
      fila({
        id: 1,
        bannerEnHome: true,
        bannerTitulo: "Primavera",
        modalCtaTipo: "PRODUCTO",
        modalCtaReferenciaId: 3,
      }),
    ]);
    productMock.findUnique.mockResolvedValue({
      id: 3,
      nombre: "Termo",
      visibleEnCatalogo: true,
    });
    productMock.count.mockResolvedValue(0);

    const res = await request(buildApp()).get("/api/campanias/activas");

    const slide = res.body.slides.find((s) => s.tipo === "CAMPANIA");
    expect(slide.ctaTipo).toBe("PRODUCTO");
    // `null` y no `undefined`: el contrato de excluyentes se lee del JSON, y
    // un undefined desaparece al serializar.
    expect(slide).toHaveProperty("promocionId", null);
  });

  // ⚠️ EL SLIDE SINTÉTICO DE OFERTAS SE ELIMINÓ EL 06/09/2026, y estos tests
  // son su lápida: fijan que NO vuelva.
  //
  // Existió como respaldo: cuando ninguna promoción tenía banner cargado, el
  // backend armaba un slide "Ofertas de la semana" con el conteo de productos
  // rebajados. La idea era que la home nunca quedara muda habiendo ofertas.
  //
  // Se sacó por decisión de producto, y el motivo es el mismo que originó toda
  // esta feature: ese copy no lo eligió nadie. El carrusel es una vidriera
  // EDITORIAL — lo que sale ahí lo decide una persona desde el panel. Un slide
  // que el sistema inventa con un título fijo es exactamente lo que se vino a
  // resolver, no algo que convenga conservar como red.
  //
  // Los productos rebajados siguen anunciados en la home por el riel "Ofertas
  // de la semana" (`RielOfertas.jsx`), que es otra superficie y no se tocó. La
  // home no queda muda: queda sin franja que nadie escribió.
  it("una promoción vigente SIN banner cargado no aporta ningún slide", async () => {
    campaniaMock.findMany.mockResolvedValue([]);
    promocionFindManyMock.mockResolvedValue([]);
    productMock.count.mockResolvedValue(12);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.slides).toEqual([]);
  });

  it("con ofertas vigentes pero sin banners, el carrusel queda VACÍO", async () => {
    // Antes acá salía el sintético. Ahora no sale nada: sin banner cargado no
    // hay franja, aunque haya doce productos rebajados.
    campaniaMock.findMany.mockResolvedValue([]);
    productMock.count.mockResolvedValue(12);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.slides).toHaveLength(0);
  });

  it("NINGÚN slide puede tener tipo OFERTAS", async () => {
    // El guard de la lápida: si alguien reintroduce el sintético, esto se cae.
    campaniaMock.findMany.mockResolvedValue([
      fila({ bannerEnHome: true, bannerTitulo: "Primavera" }),
    ]);
    productMock.count.mockResolvedValue(12);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.slides.every((s) => s.tipo !== "OFERTAS")).toBe(true);
    expect(res.body.slides.every((s) => s.tipo === "CAMPANIA")).toBe(true);
  });

  it("sin campañas y sin ofertas, slides es un array vacío", async () => {
    // Vacío, NO 404 ni null: "no hay nada" es una respuesta normal y el sitio
    // se comporta exactamente como antes de que este módulo existiera.
    campaniaMock.findMany.mockResolvedValue([]);
    productMock.count.mockResolvedValue(0);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.status).toBe(200);
    expect(res.body.slides).toEqual([]);
  });

  it("corta en MAX_SLIDES_CAMPANIA campañas", async () => {
    campaniaMock.findMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) =>
        fila({ id: i + 1, prioridad: i, bannerEnHome: true, bannerTitulo: `C${i}` }),
      ),
    );
    productMock.count.mockResolvedValue(3);

    const res = await request(buildApp()).get("/api/campanias/activas");

    // El tope pasó a ser GLOBAL (banner de promoción, task 5): antes corría
    // solo sobre campañas y el sintético se sumaba aparte, así que con cinco
    // campañas llenando el cupo todavía entraba un sexto slide de ofertas. Con
    // el tope global no queda lugar: seis franjas es peor que cortar en cinco.
    expect(res.body.slides.filter((s) => s.tipo === "CAMPANIA")).toHaveLength(5);
    expect(res.body.slides).toHaveLength(5);
  });

  it("el slide no lleva color ni texto de botón, aunque la fila los traiga", async () => {
    // 06/09/2026: el slide entero pasó a ser el enlace, así que el copy del CTA
    // es fijo en el componente y el molde sin arte va siempre en el color de
    // marca. Las dos columnas quedaron INERTES en la base (como
    // `Foto.driveFileId`), y este guard afirma que no se leen ni siquiera
    // cuando una fila vieja las trae cargadas: un payload que nadie consume ya
    // costó un bug en esta misma feature.
    campaniaMock.findMany.mockResolvedValue([
      fila({
        bannerEnHome: true,
        bannerTitulo: "Primavera",
        bannerColor: "VERDE",
        bannerCtaTexto: "Ver la selección",
        modalCtaTipo: "CATALOGO",
      }),
    ]);
    productMock.count.mockResolvedValue(0);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.slides[0]).not.toHaveProperty("color");
    expect(res.body.slides[0]).not.toHaveProperty("ctaTexto");
    // El destino SÍ sigue viajando: es lo que decide si el slide es un enlace.
    expect(res.body.slides[0].ctaDestino).toBe("/coleccion");
  });

  it("el slide NO filtra infraestructura", async () => {
    // `activas` es público: todo lo que viaje queda en un bundle que cualquiera
    // lee. El publicId de Cloudinary y la nota interna no salen. Cubre las DOS
    // fuentes del slide: `slidesDePromociones` hace su `findMany` SIN `select`
    // (ver campanias.controller.js), así que hoy solo `aSlidePromocion`, con su
    // literal explícito, es lo que evita que la fila entera de la promoción
    // viaje — este test es el guard contra que eso deje de ser así.
    campaniaMock.findMany.mockResolvedValue([
      fila({
        bannerEnHome: true,
        bannerTitulo: "Primavera",
        descripcion: "nota interna del panel",
        bannerArteCloudinaryPublicId: "campanias/abc123",
      }),
    ]);
    promocionFindManyMock.mockResolvedValue([
      {
        id: 3,
        bannerTitulo: "Envío gratis",
        bannerTexto: null,
        bannerCtaTexto: null,
        bannerArteUrl: null,
        bannerColor: null,
        descripcion: "nota interna de la promoción",
        bannerArteCloudinaryPublicId: "promociones/xyz789",
      },
    ]);
    productMock.count.mockResolvedValue(0);

    const res = await request(buildApp()).get("/api/campanias/activas");
    const crudo = JSON.stringify(res.body);

    expect(crudo).not.toContain("nota interna");
    expect(crudo).not.toContain("campanias/abc123");
    expect(crudo).not.toContain("promociones/xyz789");
    expect(crudo).not.toContain("CloudinaryPublicId");
  });
});

/**
 * El banner de promoción (task 5) entra al mismo carrusel que el de campaña.
 * `slidesDePromociones` y `aSlidePromocion` ya tienen su propio guard unitario
 * en `campanias.controller.test.js`; acá se afirma el ENSAMBLE en la ruta:
 * orden, tope global y la regla del sintético como respaldo.
 */
describe("GET /campanias/activas — slides de campaña y de promoción", () => {
  function promocionParaSlide(extra = {}) {
    return {
      id: 3,
      bannerTitulo: "Envío gratis en pedidos grandes",
      bannerTexto: null,
      bannerCtaTexto: null,
      bannerArteUrl: null,
      bannerColor: null,
      ...extra,
    };
  }

  it("pone las campañas primero y las promociones después", async () => {
    campaniaMock.findMany.mockResolvedValue([
      fila({ bannerEnHome: true, bannerTitulo: "Primavera" }),
    ]);
    promocionFindManyMock.mockResolvedValue([promocionParaSlide()]);
    productMock.count.mockResolvedValue(0);

    const res = await request(buildApp()).get("/api/campanias/activas");

    const tipos = res.body.slides.map((s) => s.tipo);
    expect(tipos.indexOf("CAMPANIA")).toBeLessThan(tipos.indexOf("PROMOCION"));
  });

  it("el slide de una promoción trae ctaTipo PROMOCION, fijo", async () => {
    // Mismo armado que el test vecino de arriba, con `promocionFindManyMock`
    // devolviendo una promoción con banner.
    campaniaMock.findMany.mockResolvedValue([]);
    promocionFindManyMock.mockResolvedValue([promocionParaSlide()]);
    productMock.count.mockResolvedValue(0);

    const res = await request(buildApp()).get("/api/campanias/activas");

    const slide = res.body.slides.find((s) => s.tipo === "PROMOCION");
    expect(slide.ctaTipo).toBe("PROMOCION");
    expect(slide).toHaveProperty("campaniaId", null);
  });

  it("corta en cinco slides en total", async () => {
    campaniaMock.findMany.mockResolvedValue(
      Array.from({ length: 4 }, (_, i) =>
        fila({ id: i + 1, prioridad: i, bannerEnHome: true, bannerTitulo: `C${i}` }),
      ),
    );
    promocionFindManyMock.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) =>
        promocionParaSlide({ id: i + 10, bannerTitulo: `P${i}` }),
      ),
    );
    productMock.count.mockResolvedValue(0);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.slides).toHaveLength(5);
  });

  it("con una promoción con banner, no aparece ningún slide de más", async () => {
    campaniaMock.findMany.mockResolvedValue([]);
    promocionFindManyMock.mockResolvedValue([promocionParaSlide()]);
    productMock.count.mockResolvedValue(12);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.slides.some((s) => s.tipo === "OFERTAS")).toBe(false);
  });

  it("sin banners cargados el carrusel queda vacío, aunque haya ofertas", async () => {
    // Este test afirmaba lo CONTRARIO hasta el 06/09/2026 ("SÍ emite el
    // sintético cuando ninguna promoción aportó slide"). El sintético se
    // eliminó: una promoción activa sin banner cargado no aporta franja, y el
    // backend ya no inventa ninguna. Los cinco productos rebajados los sigue
    // anunciando el riel de ofertas de la home, que es otra superficie.
    campaniaMock.findMany.mockResolvedValue([]);
    promocionFindManyMock.mockResolvedValue([]);
    productMock.count.mockResolvedValue(5);

    const res = await request(buildApp()).get("/api/campanias/activas");

    expect(res.body.slides).toEqual([]);
  });
});

/**
 * El corazón del cambio: la campaña guarda la INTENCIÓN y el backend arma la
 * RUTA al leer.
 *
 * Antes se guardaba la ruta escrita a mano. Eso dejaba tres agujeros mudos: una
 * categoría renombrada dejaba el botón apuntando a un slug que ya no existe, un
 * `/coleccion?etiqueta=x` pasaba la validación aunque ninguna pantalla lee ese
 * parámetro, y no había forma de saber si el destino seguía existiendo. Con la
 * intención guardada, la ruta se resuelve contra la base en cada lectura: nunca
 * puede apuntar a algo que ya no está.
 */
describe("GET /api/campanias/activas — el destino del CTA se RESUELVE al leer", () => {
  async function modalDe(campania) {
    campaniaMock.findMany.mockResolvedValue([campania]);
    const res = await request(buildApp()).get("/api/campanias/activas");
    return res.body.modal;
  }

  it("CATALOGO lleva a /coleccion SIN consultar nada", async () => {
    // Es el destino que no depende de ningún dato: gastar una consulta en él
    // sería pagar una ida a la base por cada carga de página del catálogo.
    const modal = await modalDe(conModal({ modalCtaTipo: "CATALOGO" }));

    expect(modal.ctaDestino).toBe("/coleccion");
    expect(categoriaMock.findUnique).not.toHaveBeenCalled();
    expect(productMock.findUnique).not.toHaveBeenCalled();
    expect(campaniaProductoMock.count).not.toHaveBeenCalled();
  });

  it("CAMPANIA lleva a la vitrina cuando tiene algo que mostrar", async () => {
    campaniaProductoMock.count.mockResolvedValue(1);

    const modal = await modalDe(conModal({ id: 1, modalCtaTipo: "CAMPANIA" }));

    expect(modal.ctaDestino).toBe("/coleccion?campania=1");
  });

  it("CAMPANIA con la vitrina VACÍA cae al catálogo, no a una grilla vacía", async () => {
    // El cartel lo ve todo el mundo: mandar a una pantalla sin un solo producto
    // es peor que no tener botón. Y "vacía" acá significa "sin nada PUBLICADO":
    // una vitrina de productos ocultos o agotados se ve igual de vacía.
    campaniaProductoMock.count.mockResolvedValue(0);

    const modal = await modalDe(conModal({ id: 1, modalCtaTipo: "CAMPANIA" }));

    expect(modal.ctaDestino).toBe("/coleccion");
  });

  it("CAMPANIA cuenta SOLO los productos visibles y con stock", async () => {
    campaniaProductoMock.count.mockResolvedValue(1);

    await modalDe(conModal({ id: 1, modalCtaTipo: "CAMPANIA" }));

    expect(campaniaProductoMock.count.mock.calls[0][0]).toEqual({
      where: { campaniaId: 1, product: { visibleEnCatalogo: true, stock: { gt: 0 } } },
    });
  });

  it("CATEGORIA arma la ruta desde el NOMBRE de hoy, no desde un slug guardado", async () => {
    // Éste es el bug que el cambio cierra: con la ruta persistida, renombrar la
    // categoría dejaba el botón apuntando a un slug que ya no resuelve.
    categoriaMock.findUnique.mockResolvedValue({ id: 3, nombre: "Hogar" });

    const modal = await modalDe(
      conModal({ modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 3 }),
    );

    expect(modal.ctaDestino).toBe("/coleccion/categoria/hogar");
  });

  it("CATEGORIA borrada cae al catálogo en vez de dejar el botón roto", async () => {
    // La columna no lleva FK (ver el schema: SQL Server y el error 1785), así
    // que un id colgado es un caso REAL y se degrada acá, en la lectura.
    categoriaMock.findUnique.mockResolvedValue(null);

    const modal = await modalDe(
      conModal({ modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 999 }),
    );

    expect(modal.ctaDestino).toBe("/coleccion");
  });

  it("CATEGORIA sin slug posible cae al catálogo", async () => {
    // `rutaCategoria` devuelve `null` cuando el nombre no deja slug: sin id en
    // la ruta no hay fallback, y `/coleccion/categoria/` sería una URL rota.
    categoriaMock.findUnique.mockResolvedValue({ id: 3, nombre: "***" });

    const modal = await modalDe(
      conModal({ modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 3 }),
    );

    expect(modal.ctaDestino).toBe("/coleccion");
  });

  it("PRODUCTO arma la ruta con id + slug", async () => {
    productMock.findUnique.mockResolvedValue({
      id: 12,
      nombre: "Velador LED",
      visibleEnCatalogo: true,
    });

    const modal = await modalDe(
      conModal({ modalCtaTipo: "PRODUCTO", modalCtaReferenciaId: 12 }),
    );

    expect(modal.ctaDestino).toBe("/producto/12-velador-led");
  });

  it("PRODUCTO OCULTO cae al catálogo: su ficha pública da 404", async () => {
    // Mandar ahí sería un botón roto. Un producto AGOTADO en cambio sigue
    // teniendo ficha (con el badge "Agotado"), así que el stock no se mira acá.
    productMock.findUnique.mockResolvedValue({
      id: 12,
      nombre: "Velador LED",
      visibleEnCatalogo: false,
    });

    const modal = await modalDe(
      conModal({ modalCtaTipo: "PRODUCTO", modalCtaReferenciaId: 12 }),
    );

    expect(modal.ctaDestino).toBe("/coleccion");
  });

  it("PRODUCTO agotado SÍ resuelve: su ficha existe", async () => {
    productMock.findUnique.mockResolvedValue({
      id: 12,
      nombre: "Velador LED",
      visibleEnCatalogo: true,
      stock: 0,
    });

    const modal = await modalDe(
      conModal({ modalCtaTipo: "PRODUCTO", modalCtaReferenciaId: 12 }),
    );

    expect(modal.ctaDestino).toBe("/producto/12-velador-led");
  });

  it("PRODUCTO borrado cae al catálogo", async () => {
    productMock.findUnique.mockResolvedValue(null);

    const modal = await modalDe(
      conModal({ modalCtaTipo: "PRODUCTO", modalCtaReferenciaId: 999 }),
    );

    expect(modal.ctaDestino).toBe("/coleccion");
  });

  it("sin tipo de destino no hay botón: ni texto ni destino", async () => {
    // Un modal puede ser solo un aviso. Emitir un `ctaTexto` sin destino le
    // haría dibujar a la pantalla un botón que no lleva a ningún lado.
    const modal = await modalDe(conModal({ modalCtaTipo: null, modalCtaTexto: "Ver más" }));

    expect(modal.ctaTexto).toBeNull();
    expect(modal.ctaDestino).toBeNull();
  });

  it("con destino y SIN texto, el botón usa el texto por defecto", async () => {
    // El default sale del backend (`CTA_TEXTO_POR_DEFECTO`) y no del
    // formulario: es la regla 1 —el dato derivado viaja en la respuesta—, y así
    // el panel no tiene una copia manual del string.
    const modal = await modalDe(conModal({ modalCtaTipo: "CATALOGO", modalCtaTexto: null }));

    expect(modal.ctaTexto).toBe("Ver más");
    expect(modal.ctaDestino).toBe("/coleccion");
  });

  it("NO filtra la intención ni la referencia al público", async () => {
    // El catálogo necesita la RUTA, no el modelo interno del panel.
    const modal = await modalDe(
      conModal({ modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 3 }),
    );

    expect(modal).not.toHaveProperty("modalCtaTipo");
    expect(modal).not.toHaveProperty("modalCtaReferenciaId");
  });
});

describe("POST /api/campanias — el destino del CTA", () => {
  const base = {
    nombre: "Primavera",
    tipo: "ESTACIONAL",
    desde: "2026-09-10",
    hasta: "2026-09-20",
    modalActivo: true,
    modalTitulo: "Título",
  };

  function crear(body) {
    return request(buildApp()).post("/api/campanias").set("Authorization", authHeader).send(body);
  }

  it("acepta los cuatro tipos de destino", async () => {
    campaniaMock.create.mockResolvedValue(conModal());
    categoriaMock.findUnique.mockResolvedValue({ id: 3, nombre: "Hogar" });
    productMock.findUnique.mockResolvedValue({ id: 12, nombre: "Velador", visibleEnCatalogo: true });

    for (const modalCtaTipo of ["CAMPANIA", "CATALOGO", "CATEGORIA", "PRODUCTO"]) {
      const res = await crear({ ...base, modalCtaTipo, modalCtaReferenciaId: 3 });
      expect(res.status, `tipo: ${modalCtaTipo}`).toBe(201);
    }
  });

  it("rechaza un tipo de destino fuera de la lista", async () => {
    // Ya no hay URLs que validar: lo que se guarda es una intención de un
    // conjunto cerrado, así que un valor inventado no puede entrar a la base.
    const res = await crear({ ...base, modalCtaTipo: "SITIO_EXTERNO" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/destino/i);
    expect(campaniaMock.create).not.toHaveBeenCalled();
  });

  it("rechaza una URL en el tipo: el campo dejó de aceptar rutas", async () => {
    // Guard del cambio de modelo. Un llamador viejo que mande la ruta que antes
    // funcionaba tiene que fallar con un 400 explícito, no guardarla como tipo.
    const res = await crear({ ...base, modalCtaTipo: "https://otro-sitio.com" });

    expect(res.status).toBe(400);
    expect(campaniaMock.create).not.toHaveBeenCalled();
  });

  it("rechaza un modal activo sin título", async () => {
    // Un cartel sin título es un cuadro gris encima del catálogo.
    const res = await crear({ ...base, modalTitulo: "   " });

    expect(res.status).toBe(400);
  });

  it("un modal APAGADO no exige nada", async () => {
    campaniaMock.create.mockResolvedValue(fila());

    const res = await crear({ ...base, modalActivo: false, modalTitulo: null });

    expect(res.status).toBe(201);
  });

  it("rechaza un CTA con texto pero sin tipo de destino", async () => {
    // El invariante viejo era "texto ⇒ destino" con el destino como ruta. Ahora
    // el destino es la INTENCIÓN, y un botón con texto que no lleva a ningún
    // lado sigue siendo un botón roto.
    const res = await crear({ ...base, modalCtaTexto: "Ver más", modalCtaTipo: null });

    expect(res.status).toBe(400);
    expect(campaniaMock.create).not.toHaveBeenCalled();
  });

  it("CATEGORIA sin referencia es un 400: no hay categoría a la que llevar", async () => {
    const res = await crear({ ...base, modalCtaTipo: "CATEGORIA" });

    expect(res.status).toBe(400);
    expect(campaniaMock.create).not.toHaveBeenCalled();
  });

  it("PRODUCTO sin referencia es un 400", async () => {
    const res = await crear({ ...base, modalCtaTipo: "PRODUCTO" });

    expect(res.status).toBe(400);
    expect(campaniaMock.create).not.toHaveBeenCalled();
  });

  it("CATEGORIA con un id que no existe es un 400 que NOMBRA la categoría", async () => {
    // Se verifica al ESCRIBIR además de degradar al leer: guardar una campaña
    // apuntando a algo que no existe es un error del panel, y decirlo en el
    // momento es lo que evita publicar un cartel que ya nace roto.
    categoriaMock.findUnique.mockResolvedValue(null);

    const res = await crear({ ...base, modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/categor/i);
    expect(campaniaMock.create).not.toHaveBeenCalled();
  });

  it("PRODUCTO con un id que no existe es un 400 que NOMBRA el producto", async () => {
    productMock.findUnique.mockResolvedValue(null);

    const res = await crear({ ...base, modalCtaTipo: "PRODUCTO", modalCtaReferenciaId: 999 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/producto/i);
  });

  it("CATALOGO con una referencia la GUARDA en null", async () => {
    // Una referencia con un tipo que no la usa no significa nada, y dejarla
    // guardada haría que cambiar el tipo a CATEGORIA resucite un id viejo.
    campaniaMock.create.mockResolvedValue(conModal());

    const res = await crear({ ...base, modalCtaTipo: "CATALOGO", modalCtaReferenciaId: 7 });

    expect(res.status).toBe(201);
    expect(campaniaMock.create.mock.calls[0][0].data).toMatchObject({
      modalCtaTipo: "CATALOGO",
      modalCtaReferenciaId: null,
    });
    // Y no gastó una consulta verificando una referencia que no usa.
    expect(categoriaMock.findUnique).not.toHaveBeenCalled();
    expect(productMock.findUnique).not.toHaveBeenCalled();
  });

  it("CAMPANIA con una referencia también la guarda en null", async () => {
    campaniaMock.create.mockResolvedValue(conModal());

    await crear({ ...base, modalCtaTipo: "CAMPANIA", modalCtaReferenciaId: 7 });

    expect(campaniaMock.create.mock.calls[0][0].data.modalCtaReferenciaId).toBeNull();
  });

  it("rechaza una referencia que no es un entero positivo", async () => {
    for (const modalCtaReferenciaId of [0, -3, 2.5, "3"]) {
      const res = await crear({ ...base, modalCtaTipo: "CATEGORIA", modalCtaReferenciaId });
      expect(res.status, `referencia: ${modalCtaReferenciaId}`).toBe(400);
    }
  });

  it("un PUT que no menciona el CTA CONSERVA el que estaba", async () => {
    // Misma semántica que los flags del Doodle: clave ausente = "no la toques".
    // Un llamador que solo cambie el nombre no puede borrarle el botón al cartel.
    campaniaMock.findUnique.mockResolvedValue(
      fila({ modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 3 }),
    );
    campaniaMock.update.mockResolvedValue(fila());
    categoriaMock.findUnique.mockResolvedValue({ id: 3, nombre: "Hogar" });

    await request(buildApp())
      .put("/api/campanias/1")
      .set("Authorization", authHeader)
      .send({ nombre: "Otro", tipo: "OTRO", desde: "2026-09-10", hasta: "2026-09-20" });

    expect(campaniaMock.update.mock.calls[0][0].data).toMatchObject({
      modalCtaTipo: "CATEGORIA",
      modalCtaReferenciaId: 3,
    });
  });

  it("guarda la fecha objetivo como la medianoche argentina de su día", async () => {
    campaniaMock.create.mockResolvedValue(conModal());

    await crear({ ...base, modalFechaObjetivo: "2026-09-21" });

    expect(campaniaMock.create.mock.calls[0][0].data.modalFechaObjetivo.toISOString()).toBe(
      "2026-09-21T03:00:00.000Z",
    );
  });
});

describe("GET /api/campanias — el listado del panel", () => {
  it("sin token responde 401", async () => {
    const res = await request(buildApp()).get("/api/campanias");

    expect(res.status).toBe(401);
  });

  it("con token emite el estado resuelto, para que el panel no lo calcule", async () => {
    campaniaMock.findMany.mockResolvedValue([fila()]);

    const res = await request(buildApp()).get("/api/campanias").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: 1,
      nombre: "Primavera",
      estado: "HABILITADA",
      estadoTemporal: "ACTIVA",
      activa: true,
      etiquetaEstado: "Habilitada",
      etiquetaTemporal: "Activa",
    });
  });

  it("las fechas viajan como YYYY-MM-DD, no como ISO con hora", async () => {
    // `formatFecha` del frontend detecta el formato date-only y lo descompone a
    // mano justamente para no pasarlo por `new Date()`, que en Argentina lo
    // corre al día anterior. Mandar un ISO completo rompería esa protección.
    campaniaMock.findMany.mockResolvedValue([fila()]);

    const res = await request(buildApp()).get("/api/campanias").set("Authorization", authHeader);

    expect(res.body[0].desde).toBe("2026-09-10");
    expect(res.body[0].hasta).toBe("2026-09-20");
  });
});

describe("POST /api/campanias — validaciones", () => {
  const valida = {
    nombre: "Primavera 2026",
    tipo: "ESTACIONAL",
    estado: "BORRADOR",
    desde: "2026-09-10",
    hasta: "2026-09-20",
  };

  function crear(body) {
    return request(buildApp()).post("/api/campanias").set("Authorization", authHeader).send(body);
  }

  it("sin token responde 401", async () => {
    const res = await request(buildApp()).post("/api/campanias").send(valida);

    expect(res.status).toBe(401);
  });

  it("crea con un cuerpo válido", async () => {
    campaniaMock.create.mockResolvedValue(fila({ id: 5, estado: "BORRADOR" }));

    const res = await crear(valida);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(5);
    expect(auditCreateMock).toHaveBeenCalled();
  });

  it("guarda las fechas como la medianoche ARGENTINA de su día", async () => {
    campaniaMock.create.mockResolvedValue(fila());

    await crear(valida);

    const { data } = campaniaMock.create.mock.calls[0][0];
    // La medianoche del 10 en Buenos Aires es el 10 a las 03:00 UTC.
    expect(data.desde.toISOString()).toBe("2026-09-10T03:00:00.000Z");
    expect(data.hasta.toISOString()).toBe("2026-09-20T03:00:00.000Z");
  });

  it("rechaza el nombre vacío", async () => {
    const res = await crear({ ...valida, nombre: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nombre/i);
  });

  it("rechaza un tipo que no está en la lista", async () => {
    const res = await crear({ ...valida, tipo: "BLACK_FRIDAY" });

    expect(res.status).toBe(400);
  });

  it("rechaza un estado que no está en la lista", async () => {
    const res = await crear({ ...valida, estado: "PAUSADA" });

    expect(res.status).toBe(400);
  });

  it("rechaza inicio posterior al fin", async () => {
    const res = await crear({ ...valida, desde: "2026-09-20", hasta: "2026-09-10" });

    expect(res.status).toBe(400);
    expect(campaniaMock.create).not.toHaveBeenCalled();
  });

  it("acepta inicio igual al fin: una campaña de un solo día", async () => {
    campaniaMock.create.mockResolvedValue(fila());

    const res = await crear({ ...valida, desde: "2026-12-25", hasta: "2026-12-25" });

    expect(res.status).toBe(201);
  });

  it("rechaza una fecha ilegible", async () => {
    const res = await crear({ ...valida, desde: "10/09/2026" });

    expect(res.status).toBe(400);
  });

  it("rechaza una prioridad que no es entera", async () => {
    const res = await crear({ ...valida, prioridad: 2.5 });

    expect(res.status).toBe(400);
  });

  it("acepta los flags de dónde se muestra el Doodle", async () => {
    // Sin esto los flags son una rama muerta: la columna existe, el filtro del
    // backend la lee y ninguna ruta la puede escribir, así que `doodleAdmin`
    // sale null para toda campaña que pueda existir.
    campaniaMock.create.mockResolvedValue(fila());

    await crear({ ...valida, doodleEnCatalogo: false, doodleEnAdmin: true });

    expect(campaniaMock.create.mock.calls[0][0].data).toMatchObject({
      doodleEnCatalogo: false,
      doodleEnAdmin: true,
    });
  });

  it("los flags del Doodle tienen default cuando no vienen", async () => {
    campaniaMock.create.mockResolvedValue(fila());

    await crear(valida);

    expect(campaniaMock.create.mock.calls[0][0].data).toMatchObject({
      doodleEnCatalogo: true,
      doodleEnAdmin: false,
    });
  });

  it("rechaza un flag que no es booleano", async () => {
    const res = await crear({ ...valida, doodleEnAdmin: "si" });

    expect(res.status).toBe(400);
  });

  it("un body con bannerColor o bannerCtaTexto ya no cambia nada", async () => {
    // Dejaron de ser decisiones editables (06/09/2026): el parser no los lee y
    // la escritura no los toca. Se acepta el body en vez de rechazarlo —una
    // pestaña vieja del panel los sigue mandando y no tiene por qué comerse un
    // 400 por un campo que hoy no significa nada—, pero NO llegan al `data`:
    // la columna queda con lo que ya tenía.
    campaniaMock.create.mockResolvedValue(fila());

    const res = await crear({ ...valida, bannerColor: "FUCSIA", bannerCtaTexto: "Ver" });

    expect(res.status).toBe(201);
    const { data } = campaniaMock.create.mock.calls[0][0];
    expect(data).not.toHaveProperty("bannerColor");
    expect(data).not.toHaveProperty("bannerCtaTexto");
  });
});

describe("PUT /api/campanias/:id — los flags del Doodle se pueden cambiar", () => {
  it("actualizar escribe los dos flags", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.update.mockResolvedValue(fila({ doodleEnAdmin: true }));

    const res = await request(buildApp())
      .put("/api/campanias/1")
      .set("Authorization", authHeader)
      .send({
        nombre: "Primavera",
        tipo: "ESTACIONAL",
        desde: "2026-09-10",
        hasta: "2026-09-20",
        doodleEnCatalogo: false,
        doodleEnAdmin: true,
      });

    expect(res.status).toBe(200);
    expect(campaniaMock.update.mock.calls[0][0].data).toMatchObject({
      doodleEnCatalogo: false,
      doodleEnAdmin: true,
    });
  });

  it("un flag ausente CONSERVA el valor actual, no cae al default", async () => {
    // Un PUT que no menciona el flag no puede apagarlo: el panel manda el
    // formulario entero, pero un llamador que solo cambie el nombre no tiene
    // por qué resetear dónde se muestra el Doodle.
    campaniaMock.findUnique.mockResolvedValue(fila({ doodleEnAdmin: true, doodleEnCatalogo: false }));
    campaniaMock.update.mockResolvedValue(fila());

    await request(buildApp())
      .put("/api/campanias/1")
      .set("Authorization", authHeader)
      .send({ nombre: "Otro", tipo: "OTRO", desde: "2026-09-10", hasta: "2026-09-20" });

    expect(campaniaMock.update.mock.calls[0][0].data).toMatchObject({
      doodleEnCatalogo: false,
      doodleEnAdmin: true,
    });
  });
});

describe("GET /api/campanias/opciones — la fuente de los diccionarios", () => {
  it("emite tipos y estados con su etiqueta", async () => {
    // El panel NO tiene copia de estos diccionarios. Mismo criterio que
    // `GET /ordenes/estados`: agregar un tipo se toca en un solo archivo.
    const res = await request(buildApp())
      .get("/api/campanias/opciones")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.tipos).toContainEqual({ valor: "ESTACIONAL", etiqueta: "Estacional" });
    expect(res.body.estados).toContainEqual({ valor: "HABILITADA", etiqueta: "Habilitada" });
    expect(res.body.tipos).toHaveLength(6);
    expect(res.body.estados).toHaveLength(3);
  });

  it("emite además los destinos del CTA con su etiqueta", async () => {
    const res = await request(buildApp())
      .get("/api/campanias/opciones")
      .set("Authorization", authHeader);

    expect(res.body.destinos).toHaveLength(4);
    expect(res.body.destinos).toContainEqual({
      valor: "CAMPANIA",
      etiqueta: "Los productos de la campaña",
    });
  });

  it("emite el texto por defecto del botón, para que el panel no lo copie", async () => {
    // Regla 1 de la metodología: el dato derivado viaja en la respuesta. El
    // placeholder del editor no puede ser una copia manual de este string —
    // divergiría sin error, sin test rojo y sin nada en pantalla.
    const res = await request(buildApp())
      .get("/api/campanias/opciones")
      .set("Authorization", authHeader);

    expect(res.body.ctaTextoPorDefecto).toBe("Ver más");
  });

  it("requiere auth: es una ruta del panel", async () => {
    const res = await request(buildApp()).get("/api/campanias/opciones");

    expect(res.status).toBe(401);
  });

  it("opciones YA NO emite colores del slide: dejó de ser una elección", async () => {
    // El molde sin arte va siempre en el color de marca desde que el slide
    // entero es el enlace. Un diccionario que el panel no consume es payload
    // muerto, y payload muerto ya costó un bug en esta feature.
    const res = await request(buildApp())
      .get("/api/campanias/opciones")
      .set("Authorization", authHeader);

    expect(res.body).not.toHaveProperty("coloresSlide");
  });

  it("NO se confunde con /:id — 'opciones' no se matchea como un id", async () => {
    // La trampa clásica de Express. Si la ruta literal no va antes de /:id,
    // `obtenerPorId` recibe "opciones", `Number(...)` da NaN y responde 404.
    campaniaMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .get("/api/campanias/opciones")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(campaniaMock.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * `GET /api/campanias/contador` — cuántos días faltan hasta una fecha.
 *
 * **El día lo cuenta el BACKEND, nunca el navegador.** `horarioArgentino.js` es
 * la única definición de "día" del sistema: contarlo del lado del panel haría
 * que alguien con el reloj mal puesto viera otro número, y que el preview del
 * editor no coincida con lo que el cartel le muestra al visitante.
 */
describe("GET /api/campanias/contador", () => {
  function contar(query) {
    return request(buildApp())
      .get(`/api/campanias/contador${query}`)
      .set("Authorization", authHeader);
  }

  it("cuenta los días que faltan hasta la fecha pedida", async () => {
    // La suite está parada el 15/09/2026.
    const res = await contar("?hasta=2026-09-21");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ diasFaltantes: 6 });
  });

  it("el mismo día da cero, que es lo que permite decir '¡es hoy!'", async () => {
    const res = await contar("?hasta=2026-09-15");

    expect(res.body.diasFaltantes).toBe(0);
  });

  it("rechaza un formato de fecha que no sea AAAA-MM-DD", async () => {
    // `new Date("21/09/2026")` no falla: devuelve una fecha plausible y
    // equivocada. El formato se exige antes de tocar `Date`.
    const res = await contar("?hasta=21/09/2026");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/AAAA-MM-DD/);
  });

  it("sin token responde 401: es una ruta del panel", async () => {
    const res = await request(buildApp()).get("/api/campanias/contador?hasta=2026-09-21");

    expect(res.status).toBe(401);
  });

  it("NO se confunde con /:id — 'contador' no se matchea como un id", async () => {
    // La trampa clásica de Express, la misma que ya cubre `/opciones`.
    campaniaMock.findUnique.mockResolvedValue(null);

    const res = await contar("?hasta=2026-09-21");

    expect(res.status).toBe(200);
    expect(campaniaMock.findUnique).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/campanias/:id/estado — el ON/OFF manual", () => {
  it("cambia el estado y lo audita con el anterior y el nuevo", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.update.mockResolvedValue(fila({ estado: "DESHABILITADA" }));

    const res = await request(buildApp())
      .patch("/api/campanias/1/estado")
      .set("Authorization", authHeader)
      .send({ estado: "DESHABILITADA" });

    expect(res.status).toBe(200);
    expect(res.body.activa).toBe(false);
    expect(auditCreateMock).toHaveBeenCalled();
  });

  it("rechaza un estado fuera de la lista", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());

    const res = await request(buildApp())
      .patch("/api/campanias/1/estado")
      .set("Authorization", authHeader)
      .send({ estado: "APAGADA" });

    expect(res.status).toBe(400);
    expect(campaniaMock.update).not.toHaveBeenCalled();
  });

  it("una campaña inexistente da 404", async () => {
    campaniaMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .patch("/api/campanias/99/estado")
      .set("Authorization", authHeader)
      .send({ estado: "HABILITADA" });

    expect(res.status).toBe(404);
  });
});

describe("POST /api/campanias/:id/duplicar", () => {
  it("crea una campaña NUEVA sin tocar la original", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.create.mockResolvedValue(fila({ id: 2, estado: "BORRADOR" }));

    const res = await request(buildApp())
      .post("/api/campanias/1/duplicar")
      .set("Authorization", authHeader);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(2);
    // La original no se actualiza en ninguna forma.
    expect(campaniaMock.update).not.toHaveBeenCalled();
  });

  it("el duplicado nace en BORRADOR, no publicado por accidente", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila({ estado: "HABILITADA" }));
    campaniaMock.create.mockResolvedValue(fila({ id: 2, estado: "BORRADOR" }));

    await request(buildApp()).post("/api/campanias/1/duplicar").set("Authorization", authHeader);

    expect(campaniaMock.create.mock.calls[0][0].data.estado).toBe("BORRADOR");
  });

  it("copia el doodle por referencia, sin volver a subir el archivo", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.create.mockResolvedValue(fila({ id: 2 }));

    await request(buildApp()).post("/api/campanias/1/duplicar").set("Authorization", authHeader);

    const { data } = campaniaMock.create.mock.calls[0][0];
    expect(data.doodleCloudinaryPublicId).toBe("campanias/doodle");
  });

  it("copia el destino del CTA: tipo y referencia", async () => {
    // `duplicar` enumera los campos a mano a propósito, así que una columna
    // nueva NO se cuela sola — y por lo mismo, olvidarse de sumarla acá deja el
    // duplicado sin botón sin que nada falle.
    campaniaMock.findUnique.mockResolvedValue(
      fila({ modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 3 }),
    );
    campaniaMock.create.mockResolvedValue(fila({ id: 2 }));

    await request(buildApp()).post("/api/campanias/1/duplicar").set("Authorization", authHeader);

    expect(campaniaMock.create.mock.calls[0][0].data).toMatchObject({
      modalCtaTipo: "CATEGORIA",
      modalCtaReferenciaId: 3,
    });
  });

  it("no arrastra el id ni los timestamps de la original", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.create.mockResolvedValue(fila({ id: 2 }));

    await request(buildApp()).post("/api/campanias/1/duplicar").set("Authorization", authHeader);

    const { data } = campaniaMock.create.mock.calls[0][0];
    expect(data.id).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
    expect(data.updatedAt).toBeUndefined();
  });

  it("NO copia las dos columnas inertes del banner", async () => {
    // `duplicar` enumera los campos a mano justamente para que nada se cuele
    // sin que alguien lo haya decidido. `bannerColor` y `bannerCtaTexto` dejaron
    // de tener consumidor (06/09/2026): arrastrarlos al duplicado sería
    // propagar un dato que ninguna pantalla lee, y haría creer que la elección
    // todavía existe.
    campaniaMock.findUnique.mockResolvedValue(
      fila({ bannerColor: "VERDE", bannerCtaTexto: "Ver la selección" }),
    );
    campaniaMock.create.mockResolvedValue(fila({ id: 2 }));

    await request(buildApp()).post("/api/campanias/1/duplicar").set("Authorization", authHeader);

    const { data } = campaniaMock.create.mock.calls[0][0];
    expect(data).not.toHaveProperty("bannerColor");
    expect(data).not.toHaveProperty("bannerCtaTexto");
  });

  it("copia el arte del banner por referencia, sin volver a subir el archivo", async () => {
    // Misma trampa que el Doodle: `duplicar` copia el `bannerArteCloudinaryPublicId`
    // POR REFERENCIA, así que dos campañas pueden apuntar al mismo archivo. Es la
    // consecuencia que `limpiarArteRemoto` tiene que resolver.
    campaniaMock.findUnique.mockResolvedValue(
      fila({
        bannerArteUrl: "https://res.cloudinary.com/demo/arte.jpg",
        bannerArteCloudinaryPublicId: "campanias/arte",
        bannerArteCloudinaryResourceType: "image",
      }),
    );
    campaniaMock.create.mockResolvedValue(fila({ id: 2 }));

    await request(buildApp()).post("/api/campanias/1/duplicar").set("Authorization", authHeader);

    const { data } = campaniaMock.create.mock.calls[0][0];
    expect(data.bannerArteUrl).toBe("https://res.cloudinary.com/demo/arte.jpg");
    expect(data.bannerArteCloudinaryPublicId).toBe("campanias/arte");
    expect(data.bannerArteCloudinaryResourceType).toBe("image");
  });
});

describe("PUT /api/campanias/:id/doodle", () => {
  function subir(buffer, nombre, tipo) {
    return request(buildApp())
      .put("/api/campanias/1/doodle")
      .set("Authorization", authHeader)
      .attach("doodle", buffer, { filename: nombre, contentType: tipo });
  }

  it("sin token responde 401", async () => {
    const res = await request(buildApp())
      .put("/api/campanias/1/doodle")
      .attach("doodle", PNG, { filename: "d.png", contentType: "image/png" });

    expect(res.status).toBe(401);
    expect(subirArchivoMock).not.toHaveBeenCalled();
  });

  it("sin archivo responde 400", async () => {
    const res = await request(buildApp())
      .put("/api/campanias/1/doodle")
      .set("Authorization", authHeader);

    expect(res.status).toBe(400);
  });

  it("rechaza un tipo no permitido con 400, no con 500", async () => {
    // Lo corta el `fileFilter` de multer. Sin el `err.status = 400` explícito,
    // un MulterError sale por el error handler como 500 opaco.
    const res = await subir(Buffer.from("GIF89a"), "d.gif", "image/gif");

    expect(res.status).toBe(400);
    expect(subirArchivoMock).not.toHaveBeenCalled();
  });

  it("rechaza un archivo cuyos BYTES no son los de su mime declarado", async () => {
    // Defensa en profundidad: el mimetype lo declara el cliente y es
    // falsificable. Nada llega a Cloudinary sin que los bytes coincidan.
    campaniaMock.findUnique.mockResolvedValue(fila());

    const res = await subir(Buffer.from("no soy una imagen"), "d.png", "image/png");

    expect(res.status).toBe(400);
    expect(subirArchivoMock).not.toHaveBeenCalled();
  });

  it("sube, guarda los tres campos y recién DESPUÉS borra el anterior", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.findMany.mockResolvedValue([]);
  promocionFindManyMock.mockResolvedValue([]);
  campaniaPromocionMock.findMany.mockResolvedValue([]);
  transactionMock.mockImplementation(async (arg) =>
    typeof arg === "function"
      ? arg({
          campaniaPromocion: {
            deleteMany: (...a) => campaniaPromocionMock.deleteMany(...a),
            createMany: (...a) => campaniaPromocionMock.createMany(...a),
          },
        })
      : Promise.all(arg),
  ); // nadie más comparte el doodle viejo
    campaniaMock.update.mockResolvedValue(
      fila({ doodleUrl: "https://res.cloudinary.com/demo/nuevo.png" }),
    );

    const res = await subir(PNG, "d.png", "image/png");

    expect(res.status).toBe(200);
    expect(campaniaMock.update.mock.calls[0][0].data).toMatchObject({
      doodleUrl: "https://res.cloudinary.com/demo/nuevo.png",
      doodleCloudinaryPublicId: "campanias/nuevo",
      doodleCloudinaryResourceType: "image",
    });
    expect(eliminarArchivoMock).toHaveBeenCalledWith("campanias/doodle", "image");
  });

  it("una campaña inexistente da 404 y no sube nada", async () => {
    campaniaMock.findUnique.mockResolvedValue(null);

    const res = await subir(PNG, "d.png", "image/png");

    expect(res.status).toBe(404);
    expect(subirArchivoMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/campanias/:id/doodle", () => {
  function quitar() {
    return request(buildApp())
      .delete("/api/campanias/1/doodle")
      .set("Authorization", authHeader);
  }

  it("limpia los tres campos y borra el archivo remoto", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.findMany.mockResolvedValue([]);
  promocionFindManyMock.mockResolvedValue([]);
  campaniaPromocionMock.findMany.mockResolvedValue([]);
  transactionMock.mockImplementation(async (arg) =>
    typeof arg === "function"
      ? arg({
          campaniaPromocion: {
            deleteMany: (...a) => campaniaPromocionMock.deleteMany(...a),
            createMany: (...a) => campaniaPromocionMock.createMany(...a),
          },
        })
      : Promise.all(arg),
  );
    campaniaMock.update.mockResolvedValue(fila({ doodleUrl: null }));

    const res = await quitar();

    expect(res.status).toBe(200);
    expect(campaniaMock.update.mock.calls[0][0].data).toEqual({
      doodleUrl: null,
      doodleCloudinaryPublicId: null,
      doodleCloudinaryResourceType: null,
    });
    expect(eliminarArchivoMock).toHaveBeenCalledWith("campanias/doodle", "image");
  });

  it("NO borra el archivo si otra campaña comparte el mismo publicId", async () => {
    // Éste es el guard de la duplicación. `duplicar` copia el Doodle POR
    // REFERENCIA —el mismo archivo en Cloudinary, sin volver a subirlo—, así
    // que un borrado ciego dejaría a la otra campaña con una URL de CDN en 404,
    // sin ningún error de este lado. Es exactamente la trampa que el CLAUDE.md
    // ya documenta para las imágenes generadas adoptadas.
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.findMany.mockResolvedValue([{ id: 2 }]); // el duplicado
    campaniaMock.update.mockResolvedValue(fila({ doodleUrl: null }));

    const res = await quitar();

    expect(res.status).toBe(200);
    expect(eliminarArchivoMock).not.toHaveBeenCalled();
  });

  it("una campaña sin doodle no intenta borrar nada", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila({ doodleCloudinaryPublicId: null }));
    campaniaMock.update.mockResolvedValue(fila({ doodleUrl: null }));

    await quitar();

    expect(eliminarArchivoMock).not.toHaveBeenCalled();
  });
});

describe("PUT / DELETE /api/campanias/:id/arte", () => {
  it("guarda el arte y borra el archivo anterior", async () => {
    campaniaMock.findUnique.mockResolvedValue(
      fila({ id: 7, bannerArteCloudinaryPublicId: "campanias/viejo" }),
    );
    campaniaMock.findMany.mockResolvedValue([]); // nadie más lo referencia
    campaniaMock.update.mockResolvedValue(fila({ id: 7 }));

    const res = await request(buildApp())
      .put("/api/campanias/7/arte")
      .set("Authorization", authHeader)
      .attach("arte", PNG, { filename: "arte.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(eliminarArchivoMock).toHaveBeenCalledWith("campanias/viejo", expect.anything());
  });

  it("NO borra un arte que otra campaña comparte", async () => {
    // `duplicar` copia el publicId por REFERENCIA: dos campañas pueden apuntar
    // al mismo archivo, y un borrado ciego deja la otra con un CDN en 404.
    campaniaMock.findUnique.mockResolvedValue(
      fila({ id: 7, bannerArteCloudinaryPublicId: "campanias/compartido" }),
    );
    campaniaMock.findMany.mockResolvedValue([fila({ id: 9 })]); // otra lo usa

    await request(buildApp())
      .put("/api/campanias/7/arte")
      .set("Authorization", authHeader)
      .attach("arte", PNG, { filename: "arte.png", contentType: "image/png" });

    expect(eliminarArchivoMock).not.toHaveBeenCalled();
  });

  it("DELETE deja las tres columnas del arte en null", async () => {
    campaniaMock.findUnique.mockResolvedValue(
      fila({ id: 7, bannerArteCloudinaryPublicId: "campanias/x" }),
    );
    campaniaMock.findMany.mockResolvedValue([]);
    campaniaMock.update.mockResolvedValue(fila({ id: 7 }));

    await request(buildApp()).delete("/api/campanias/7/arte").set("Authorization", authHeader);

    expect(campaniaMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          bannerArteUrl: null,
          bannerArteCloudinaryPublicId: null,
          bannerArteCloudinaryResourceType: null,
        },
      }),
    );
  });

  it("las dos rutas exigen auth", async () => {
    expect((await request(buildApp()).put("/api/campanias/7/arte")).status).toBe(401);
    expect((await request(buildApp()).delete("/api/campanias/7/arte")).status).toBe(401);
  });
});

describe("DELETE /api/campanias/:id", () => {
  it("un usuario sin permiso de borrado no puede eliminar", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: false });
    campaniaMock.findUnique.mockResolvedValue(fila());

    const res = await request(buildApp())
      .delete("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(403);
    expect(campaniaMock.delete).not.toHaveBeenCalled();
  });

  it("con permiso elimina y audita", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.delete.mockResolvedValue(fila());

    const res = await request(buildApp())
      .delete("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(auditCreateMock).toHaveBeenCalled();
  });

  it("borra también el arte del banner, no solo el doodle", async () => {
    // Antes de esta corrección `eliminar` solo llamaba a `limpiarDoodleRemoto`:
    // el arte del slide quedaba huérfano en Cloudinary para siempre al borrar
    // la campaña que lo tenía en exclusiva.
    campaniaMock.findUnique.mockResolvedValue(
      fila({ bannerArteCloudinaryPublicId: "campanias/arte-huerfano" }),
    );
    campaniaMock.findMany.mockResolvedValue([]); // nadie más lo comparte
    campaniaMock.delete.mockResolvedValue(fila());

    const res = await request(buildApp())
      .delete("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(eliminarArchivoMock).toHaveBeenCalledWith("campanias/doodle", "image");
    expect(eliminarArchivoMock).toHaveBeenCalledWith("campanias/arte-huerfano", "image");
  });

  it("NO borra el arte si otra campaña lo comparte por referencia", async () => {
    campaniaMock.findUnique.mockResolvedValue(
      fila({ bannerArteCloudinaryPublicId: "campanias/arte-compartido" }),
    );
    campaniaMock.findMany.mockResolvedValue([{ id: 2 }]); // el duplicado
    campaniaMock.delete.mockResolvedValue(fila());

    const res = await request(buildApp())
      .delete("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(eliminarArchivoMock).not.toHaveBeenCalledWith("campanias/arte-compartido", "image");
  });
});

/**
 * Guard de la asociación campaña ↔ promociones.
 *
 * De acá sale la regla más útil del módulo: apagar una campaña apaga TODAS sus
 * promociones de una, sin desactivar nada una por una. No hay ningún estado que
 * copiar — la vigencia la hereda la asociación.
 */
describe("PUT /api/campanias/:id/promociones", () => {
  function asociar(promocionIds) {
    return request(buildApp())
      .put("/api/campanias/1/promociones")
      .set("Authorization", authHeader)
      .send({ promocionIds });
  }

  beforeEach(() => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    promocionFindManyMock.mockResolvedValue([{ id: 3 }, { id: 4 }]);
    campaniaPromocionMock.deleteMany.mockResolvedValue({ count: 0 });
    campaniaPromocionMock.createMany.mockResolvedValue({ count: 2 });
  });

  it("reemplaza la lista completa en una transacción", async () => {
    const res = await asociar([3, 4]);

    expect(res.status).toBe(200);
    expect(campaniaPromocionMock.deleteMany).toHaveBeenCalledWith({ where: { campaniaId: 1 } });
    expect(campaniaPromocionMock.createMany.mock.calls[0][0].data).toEqual([
      { campaniaId: 1, promocionId: 3 },
      { campaniaId: 1, promocionId: 4 },
    ]);
  });

  it("una lista vacía desasocia todo, sin borrar ninguna promoción", async () => {
    const res = await asociar([]);

    expect(res.status).toBe(200);
    expect(campaniaPromocionMock.deleteMany).toHaveBeenCalled();
    expect(campaniaPromocionMock.createMany).not.toHaveBeenCalled();
  });

  it("rechaza una promoción que no existe", async () => {
    promocionFindManyMock.mockResolvedValue([{ id: 3 }]);

    const res = await asociar([3, 999]);

    expect(res.status).toBe(400);
    expect(campaniaPromocionMock.createMany).not.toHaveBeenCalled();
  });

  it("rechaza ids repetidos", async () => {
    const res = await asociar([3, 3]);

    expect(res.status).toBe(400);
  });

  it("sin token responde 401", async () => {
    const res = await request(buildApp()).put("/api/campanias/1/promociones").send({ promocionIds: [] });

    expect(res.status).toBe(401);
  });
});

/**
 * Guard de la VITRINA: qué productos muestra una campaña.
 *
 * La regla que sostiene todo el bloque: la vitrina NO es una promoción. Un
 * producto puede estar en la vitrina de Navidad a precio de lista — si listar
 * productos exigiera un descuento, "Navidad" tendría que inventar rebajas que
 * el negocio no quiso dar.
 */
describe("PUT /api/campanias/:id/productos", () => {
  function asociar(productIds) {
    return request(buildApp())
      .put("/api/campanias/1/productos")
      .set("Authorization", authHeader)
      .send({ productIds });
  }

  beforeEach(() => {
    campaniaMock.findUnique.mockResolvedValue(conDetalle({ productos: [enVitrina()] }));
    productMock.findMany.mockResolvedValue([{ id: 7 }, { id: 8 }]);
    campaniaProductoMock.createMany.mockResolvedValue({ count: 2 });
  });

  it("reemplaza la lista completa en una transacción", async () => {
    const res = await asociar([7, 8]);

    expect(res.status).toBe(200);
    expect(campaniaProductoMock.deleteMany).toHaveBeenCalledWith({ where: { campaniaId: 1 } });
    expect(campaniaProductoMock.createMany.mock.calls[0][0].data).toEqual([
      { campaniaId: 1, productId: 7 },
      { campaniaId: 1, productId: 8 },
    ]);
  });

  it("una lista vacía desasocia todo, sin borrar ningún producto", async () => {
    // Desasociar NO borra el producto: sigue en el catálogo, sólo deja de estar
    // en la vitrina de esta campaña.
    campaniaMock.findUnique.mockResolvedValue(conDetalle());

    const res = await asociar([]);

    expect(res.status).toBe(200);
    expect(campaniaProductoMock.deleteMany).toHaveBeenCalled();
    expect(campaniaProductoMock.createMany).not.toHaveBeenCalled();
  });

  it("rechaza un producto que ya no existe, nombrándolo, y no escribe nada", async () => {
    productMock.findMany.mockResolvedValue([{ id: 7 }]);

    const res = await asociar([7, 999]);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("999");
    expect(campaniaProductoMock.createMany).not.toHaveBeenCalled();
  });

  it("rechaza ids repetidos", async () => {
    // Asociar dos veces el mismo producto explota contra la PK compuesta como
    // un P2002 que no explica nada.
    const res = await asociar([7, 7]);

    expect(res.status).toBe(400);
    expect(campaniaProductoMock.createMany).not.toHaveBeenCalled();
  });

  it("rechaza más de 200 productos", async () => {
    const doscientosUno = Array.from({ length: 201 }, (_, i) => i + 1);

    const res = await asociar(doscientosUno);

    expect(res.status).toBe(400);
    expect(campaniaProductoMock.createMany).not.toHaveBeenCalled();
  });

  it("sin token responde 401", async () => {
    const res = await request(buildApp())
      .put("/api/campanias/1/productos")
      .send({ productIds: [] });

    expect(res.status).toBe(401);
  });

  it("responde el DETALLE completo, con la portada de cada producto", async () => {
    // Devolver sólo los ids obligaría al editor a un segundo GET para pintar la
    // vitrina que acaba de guardar.
    const res = await asociar([7]);

    expect(res.body.productos).toEqual([
      {
        id: 7,
        nombre: "Termo Stanley",
        sku: "YIMA-0007",
        precio: "48000",
        fotoPortada: "https://res.cloudinary.com/demo/termo.webp",
        visibleEnCatalogo: true,
        stock: 5,
      },
    ]);
  });

  it("un producto sin fotos emite fotoPortada null, no un undefined que se pierde en el JSON", async () => {
    campaniaMock.findUnique.mockResolvedValue(
      conDetalle({ productos: [enVitrina({ fotos: [] })] }),
    );

    const res = await asociar([7]);

    expect(res.body.productos[0].fotoPortada).toBeNull();
  });

  it("audita el cambio con los ids que se guardaron", async () => {
    await asociar([7, 8]);

    expect(auditCreateMock).toHaveBeenCalled();
    const { data } = auditCreateMock.mock.calls[0][0];
    expect(data.accion).toBe("ACTUALIZAR_PRODUCTOS");
    expect(data.entidad).toBe("Campania");
  });

  it("una campaña inexistente da 404 antes de tocar la vitrina", async () => {
    campaniaMock.findUnique.mockResolvedValue(null);

    const res = await asociar([7]);

    expect(res.status).toBe(404);
    expect(campaniaProductoMock.deleteMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/campanias/:id — el detalle trae la vitrina", () => {
  it("emite productos[] con la forma que consume el editor", async () => {
    campaniaMock.findUnique.mockResolvedValue(
      conDetalle({
        productos: [enVitrina()],
        promociones: [{ promocion: { id: 3, nombre: "Liquidación" } }],
      }),
    );

    const res = await request(buildApp())
      .get("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.promociones).toEqual([{ id: 3, nombre: "Liquidación" }]);
    expect(res.body.productos).toEqual([
      {
        id: 7,
        nombre: "Termo Stanley",
        sku: "YIMA-0007",
        precio: "48000",
        fotoPortada: "https://res.cloudinary.com/demo/termo.webp",
        visibleEnCatalogo: true,
        stock: 5,
      },
    ]);
  });

  it("una campaña sin vitrina emite un array vacío, no la clave ausente", async () => {
    campaniaMock.findUnique.mockResolvedValue(conDetalle());

    const res = await request(buildApp())
      .get("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.body.productos).toEqual([]);
  });

  it("una campaña inexistente da 404", async () => {
    campaniaMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .get("/api/campanias/99")
      .set("Authorization", authHeader);

    expect(res.status).toBe(404);
  });

  it("emite la intención del CTA cruda, que es lo que el editor edita", async () => {
    // El PANEL recibe el modelo (tipo + id); el CATÁLOGO recibe la ruta ya
    // resuelta. Son dos formas distintas del mismo dato a propósito: un
    // `<select>` no puede editar una ruta armada.
    campaniaMock.findUnique.mockResolvedValue(
      conDetalle({ modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 3 }),
    );
    categoriaMock.findUnique.mockResolvedValue({ id: 3, nombre: "Hogar" });

    const res = await request(buildApp())
      .get("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.body).toMatchObject({ modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 3 });
  });

  it("suma el NOMBRE de la referencia, para que el editor muestre qué eligió", async () => {
    // Sin el nombre el formulario mostraría "categoría 3", o tendría que pedir
    // el catálogo entero de categorías para traducir un id.
    campaniaMock.findUnique.mockResolvedValue(
      conDetalle({ modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 3 }),
    );
    categoriaMock.findUnique.mockResolvedValue({ id: 3, nombre: "Hogar" });

    const res = await request(buildApp())
      .get("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.body.modalCtaReferencia).toEqual({ id: 3, nombre: "Hogar" });
  });

  it("con una referencia que ya no existe emite null, no un id colgado", async () => {
    categoriaMock.findUnique.mockResolvedValue(null);
    campaniaMock.findUnique.mockResolvedValue(
      conDetalle({ modalCtaTipo: "CATEGORIA", modalCtaReferenciaId: 999 }),
    );

    const res = await request(buildApp())
      .get("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.body.modalCtaReferencia).toBeNull();
  });

  it("un destino sin referencia emite la clave en null, sin consultar nada", async () => {
    campaniaMock.findUnique.mockResolvedValue(conDetalle({ modalCtaTipo: "CATALOGO" }));

    const res = await request(buildApp())
      .get("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.body).toHaveProperty("modalCtaReferencia", null);
    expect(categoriaMock.findUnique).not.toHaveBeenCalled();
    expect(productMock.findUnique).not.toHaveBeenCalled();
  });

  it("con tipo PRODUCTO la referencia sale del producto", async () => {
    campaniaMock.findUnique.mockResolvedValue(
      conDetalle({ modalCtaTipo: "PRODUCTO", modalCtaReferenciaId: 12 }),
    );
    productMock.findUnique.mockResolvedValue({ id: 12, nombre: "Velador LED" });

    const res = await request(buildApp())
      .get("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.body.modalCtaReferencia).toEqual({ id: 12, nombre: "Velador LED" });
    expect(categoriaMock.findUnique).not.toHaveBeenCalled();
  });
});

describe("la vitrina en el duplicado y en el listado", () => {
  it("duplicar COPIA la vitrina con el id nuevo", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.create.mockResolvedValue(fila({ id: 2, estado: "BORRADOR" }));
    campaniaProductoMock.findMany.mockResolvedValue([{ productId: 7 }, { productId: 8 }]);

    const res = await request(buildApp())
      .post("/api/campanias/1/duplicar")
      .set("Authorization", authHeader);

    expect(res.status).toBe(201);
    expect(campaniaProductoMock.createMany.mock.calls[0][0].data).toEqual([
      { campaniaId: 2, productId: 7 },
      { campaniaId: 2, productId: 8 },
    ]);
  });

  it("duplicar una campaña sin vitrina no escribe filas de más", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.create.mockResolvedValue(fila({ id: 2 }));
    campaniaProductoMock.findMany.mockResolvedValue([]);

    await request(buildApp()).post("/api/campanias/1/duplicar").set("Authorization", authHeader);

    expect(campaniaProductoMock.createMany).not.toHaveBeenCalled();
  });

  it("duplicar NO copia las promociones — es deliberado", async () => {
    // El duplicado nace en BORRADOR para armar la campaña del año que viene:
    // arrastrarle los descuentos del año pasado sería decidir plata por el admin.
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.create.mockResolvedValue(fila({ id: 2 }));
    campaniaProductoMock.findMany.mockResolvedValue([{ productId: 7 }]);

    await request(buildApp()).post("/api/campanias/1/duplicar").set("Authorization", authHeader);

    expect(campaniaPromocionMock.createMany).not.toHaveBeenCalled();
  });

  it("el listado emite cantidadProductos, contada por la base", async () => {
    // El panel no puede contar una relación que el listado no trae: son N
    // consultas para pintar una grilla. El `_count` la resuelve en la misma.
    campaniaMock.findMany.mockResolvedValue([fila({ _count: { productos: 4 } })]);

    const res = await request(buildApp()).get("/api/campanias").set("Authorization", authHeader);

    expect(campaniaMock.findMany.mock.calls[0][0].include).toEqual({
      _count: { select: { productos: true } },
    });
    expect(res.body[0].cantidadProductos).toBe(4);
  });

  it("crear NO emite cantidadProductos: su fila no tiene _count y saldría un cero falso", async () => {
    // `mapCampania` lo comparten crear/actualizar/cambiarEstado/duplicar/doodle,
    // que escriben sin `_count`. Emitir la clave ahí devolvería 0 para una
    // campaña con productos y la pantalla mostraría un cero que no es cierto.
    campaniaMock.create.mockResolvedValue(fila({ id: 5 }));

    const res = await request(buildApp())
      .post("/api/campanias")
      .set("Authorization", authHeader)
      .send({ nombre: "Navidad", tipo: "ESTACIONAL", desde: "2026-12-01", hasta: "2026-12-25" });

    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty("cantidadProductos");
  });
});

describe("El bloque del banner de la home", () => {
  const base = {
    nombre: "Primavera",
    tipo: "ESTACIONAL",
    desde: "2026-09-10",
    hasta: "2026-09-20",
  };

  function crear(body) {
    return request(buildApp()).post("/api/campanias").set("Authorization", authHeader).send(body);
  }

  it("un banner prendido necesita un título", async () => {
    const res = await crear({ ...base, bannerEnHome: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Un banner activo necesita un título.");
  });

  it("apagado no exige nada: los textos a medio escribir se guardan", async () => {
    campaniaMock.create.mockResolvedValue(fila({ bannerEnHome: false, bannerTitulo: null }));

    const res = await crear({ ...base, bannerEnHome: false, bannerTexto: "a medio escribir" });

    expect(res.status).toBe(201);
    expect(campaniaMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bannerEnHome: false, bannerTexto: "a medio escribir" }),
      }),
    );
  });

  it("el texto del banner topea en 200, no en los 1000 del cartel", async () => {
    const res = await crear({ ...base, bannerTexto: "x".repeat(201) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("`bannerTexto` no puede superar los 200 caracteres.");
  });

  it("el título del banner topea en 120", async () => {
    const res = await crear({ ...base, bannerTitulo: "x".repeat(121) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("`bannerTitulo` no puede superar los 120 caracteres.");
  });

  it("el texto del botón ya no se valida contra el destino: dejó de existir", async () => {
    // Existía un 400 ("El botón del banner tiene texto pero no lleva a ningún
    // lado") que cruzaba `bannerCtaTexto` con `modalCtaTipo`. Sin campo no hay
    // cruce posible, y una pestaña vieja del panel que todavía mande el texto no
    // puede quedarse trabada en un error por un dato que hoy se ignora.
    campaniaMock.create.mockResolvedValue(fila());

    const res = await crear({ ...base, bannerEnHome: true, bannerTitulo: "T", bannerCtaTexto: "Ver" });

    expect(res.status).toBe(201);
  });

  it("rechaza el marcador {dias} en el texto del banner", async () => {
    // Hoy `conDias` lo borraba en silencio: el admin escribía "Faltan {dias}
    // dias", guardaba sin error, y el visitante leia "Faltan dias".
    const res = await crear({
      ...base,
      bannerEnHome: true,
      bannerTitulo: "Primavera",
      bannerTexto: "Faltan {dias} dias",
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contador .*es del cartel/i);
  });

  it("el marcador {dias} SIGUE siendo válido en el texto del cartel", async () => {
    // El cartel conserva su contador: tiene `modalFechaObjetivo` propio.
    campaniaMock.create.mockResolvedValue(fila());

    const res = await crear({
      ...base,
      modalActivo: true,
      modalTitulo: "Primavera",
      modalTexto: "Faltan {dias} dias",
    });

    expect(res.status).toBe(201);
  });

  it("el detalle del panel emite las columnas que el editor todavía edita", async () => {
    campaniaMock.findUnique.mockResolvedValue(
      conDetalle({
        bannerEnHome: true,
        bannerTitulo: "Semana del Hogar",
        bannerTexto: "Hasta 30 %.",
      }),
    );

    const res = await request(buildApp())
      .get("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.body).toMatchObject({
      bannerEnHome: true,
      bannerTitulo: "Semana del Hogar",
      bannerTexto: "Hasta 30 %.",
    });
  });

  it("el detalle NO emite el color ni el texto del botón, aunque estén guardados", async () => {
    // Son columnas inertes desde el 06/09/2026. Emitirlas le daría al editor un
    // dato que no tiene dónde mostrar y que el PUT tampoco puede volver a
    // escribir: la forma en que un campo borrado a medias vuelve como bug.
    campaniaMock.findUnique.mockResolvedValue(
      conDetalle({ bannerColor: "VERDE", bannerCtaTexto: "Ver la selección" }),
    );

    const res = await request(buildApp())
      .get("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.body).not.toHaveProperty("bannerColor");
    expect(res.body).not.toHaveProperty("bannerCtaTexto");
  });

  it("el detalle del panel emite también el arte guardado", async () => {
    // Sin esto la vista previa del editor recibe `arteUrl: null` siempre: el
    // dato queda subido en Cloudinary pero el panel nunca lo ve.
    campaniaMock.findUnique.mockResolvedValue(
      conDetalle({ bannerArteUrl: "https://res.cloudinary.com/demo/arte.jpg" }),
    );

    const res = await request(buildApp())
      .get("/api/campanias/1")
      .set("Authorization", authHeader);

    expect(res.body.bannerArteUrl).toBe("https://res.cloudinary.com/demo/arte.jpg");
  });
});

describe("POST /api/campanias/:id/evento", () => {
  it("es PÚBLICA: responde 201 sin Authorization", async () => {
    campaniaMock.findUnique.mockResolvedValue({ id: 12 });
    eventoTraficoCreateMock.mockResolvedValue({ id: 1 });

    const res = await request(buildApp())
      .post("/api/campanias/12/evento")
      .send({ tipo: "IMPRESION_COMERCIAL", origen: "BANNER" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 1 });
  });

  it("una campaña inexistente es 404", async () => {
    campaniaMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .post("/api/campanias/999/evento")
      .send({ tipo: "IMPRESION_COMERCIAL", origen: "BANNER" });

    expect(res.status).toBe(404);
    expect(eventoTraficoCreateMock).not.toHaveBeenCalled();
  });

  it("un tipo histórico es 400: esta ruta no fabrica VISTA_PRODUCTO", async () => {
    const res = await request(buildApp())
      .post("/api/campanias/12/evento")
      .send({ tipo: "VISTA_PRODUCTO", origen: "BANNER" });

    expect(res.status).toBe(400);
    expect(campaniaMock.findUnique).not.toHaveBeenCalled();
  });

  // El techo es el de lectura pública (600/5min), no el de POST /eventos
  // (300): un visitante genera por carga de la home una impresión del cartel
  // más una por slide que ve más los clicks, y una oficina detrás de un NAT
  // comparte una sola IP.
  //
  // Se afirma sobre el header y no disparando 601 requests: mismo criterio
  // que `products.ratelimit.test.js` y `anuncios.ratelimit.test.js` — el
  // comportamiento del 429 en sí ya está cubierto por
  // `rateLimit.middleware.test.js`, y una ráfaga de cientos de requests acá
  // sería lenta y, peor, frágil: comparte balde por IP con los tests
  // anteriores de este mismo describe, así que un loop de exactamente 600
  // fallaría por los tres consumidos arriba, no por un bug real.
  it("expone RateLimit-Limit=600 en POST /:id/evento", async () => {
    campaniaMock.findUnique.mockResolvedValue({ id: 12 });
    eventoTraficoCreateMock.mockResolvedValue({ id: 1 });

    const res = await request(buildApp())
      .post("/api/campanias/12/evento")
      .send({ tipo: "IMPRESION_COMERCIAL", origen: "BANNER" });

    expect(res.headers["ratelimit-limit"]).toBe("600");
  });
});
