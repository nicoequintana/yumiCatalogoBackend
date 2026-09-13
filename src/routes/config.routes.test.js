import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const configuracionContactoMock = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
};
const configuracionHomeMock = {
  findUnique: vi.fn(),
  upsert: vi.fn(),
};
const productMock = {
  findUnique: vi.fn(),
};
// `resolverDescuentos` (lib/precioEfectivo.js) no se mockea: corre de verdad y
// pega contra `prisma.promocionItem.findMany`, mismo criterio que
// `products.routes.conDescuento.test.js`. Sin promociones vigentes (caso
// normal de estos tests) devuelve `[]`.
const promocionItemFindManyMock = vi.fn();
const usuarioFindUniqueMock = vi.fn();
const auditCreateMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    configuracionContacto: {
      findUnique: (...args) => configuracionContactoMock.findUnique(...args),
      upsert: (...args) => configuracionContactoMock.upsert(...args),
    },
    configuracionHome: {
      findUnique: (...args) => configuracionHomeMock.findUnique(...args),
      upsert: (...args) => configuracionHomeMock.upsert(...args),
    },
    product: {
      findUnique: (...args) => productMock.findUnique(...args),
    },
    promocionItem: {
      findMany: (...args) => promocionItemFindManyMock(...args),
    },
    usuario: { findUnique: (...args) => usuarioFindUniqueMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
  },
}));

const { default: configRouter } = await import("./config.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/config", configRouter);
  app.use(manejadorDeErrores);
  return app;
}

const ENV_BASE = {
  WHATSAPP_NUMERO: "5491122334455",
  WHATSAPP_HORA_DESDE: "9",
  WHATSAPP_HORA_HASTA: "18",
  WHATSAPP_DIAS: "1,2,3,4,5",
};

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "7d",
});
const authHeader = `Bearer ${token}`;

const FILA_DB = {
  id: 1,
  whatsappNumero: "5491199998888",
  whatsappHoraDesde: 10,
  whatsappHoraHasta: 20,
  whatsappDias: "1,2,3,4,5,6",
  email: "contacto@yima.test",
  instagramUrl: "https://instagram.com/yima",
  facebookUrl: "https://facebook.com/yima",
  tiktokUrl: "https://tiktok.com/@yima",
  direccion: "Calle Falsa 123",
  updatedAt: new Date("2026-09-13T00:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, ENV_BASE);
  auditCreateMock.mockResolvedValue({ id: 1 });
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
  configuracionContactoMock.findUnique.mockResolvedValue(null);
  configuracionHomeMock.findUnique.mockResolvedValue(null);
  productMock.findUnique.mockResolvedValue(null);
  promocionItemFindManyMock.mockResolvedValue([]);
});

/**
 * Fila de `Product` con la forma de `PRODUCT_INCLUDE` (todas las relaciones
 * que `mapProducto` necesita para no explotar) — mismo patrón que
 * `filaDeProducto` de `products.mapper.test.js`. `precio` imita un
 * `Decimal` de Prisma con un `{toString}` en vez de traer la clase real.
 */
function productoDeDetalle(extra = {}) {
  return {
    id: 9,
    sku: "YIMA-ICONO-0009",
    nombre: "Producto ícono",
    descripcion: "El producto que abre la home",
    precio: { toString: () => "45000" },
    etiqueta: null,
    categoria: { id: 1, nombre: "Cocina" },
    vistas: 0,
    compartidos: 0,
    favoritosCount: 0,
    visibleEnCatalogo: true,
    stock: 5,
    destacado: false,
    fraseComercial: "El favorito de la casa.",
    porQueLoVasAQuerer: "Porque sí.",
    tePasaEsto: null,
    caracteristicas: [],
    listas: [],
    especificaciones: [],
    fotos: [],
    video: null,
    createdAt: new Date("2026-08-26"),
    updatedAt: new Date("2026-08-26"),
    ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/config/whatsapp", () => {
  it("con la fila vacía en la base, cae entero al fallback de entorno", async () => {
    // Miércoles 2026-01-07 10:00 ART = 13:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-07T13:00:00.000Z"));

    const res = await request(buildApp()).get("/api/config/whatsapp");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      numero: "5491122334455",
      dentroDeHorario: true,
      textoHorario: "Te respondemos ahora",
    });
  });

  it("devuelve dentroDeHorario=false y el texto correspondiente fuera de horario", async () => {
    // Miércoles 2026-01-07 20:00 ART = 23:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-07T23:00:00.000Z"));

    const res = await request(buildApp()).get("/api/config/whatsapp");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      numero: "5491122334455",
      dentroDeHorario: false,
      textoHorario: "Fuera de horario de atención — te respondemos apenas podamos",
    });
  });

  it("dentroDeHorario=false en un día no habilitado (domingo)", async () => {
    // Domingo 2026-01-04 10:00 ART = 13:00 UTC.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T13:00:00.000Z"));

    const res = await request(buildApp()).get("/api/config/whatsapp");

    expect(res.status).toBe(200);
    expect(res.body.dentroDeHorario).toBe(false);
  });

  it("no requiere autenticación", async () => {
    const res = await request(buildApp()).get("/api/config/whatsapp");
    expect(res.status).not.toBe(401);
  });

  it("con la fila cargada en la base, sus valores ganan sobre el entorno", async () => {
    configuracionContactoMock.findUnique.mockResolvedValue(FILA_DB);
    // Miércoles 2026-01-07 12:00 ART = 15:00 UTC — dentro de 10-20 (DB), fuera de 9-18 no aplica acá.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-07T15:00:00.000Z"));

    const res = await request(buildApp()).get("/api/config/whatsapp");

    expect(res.status).toBe(200);
    expect(res.body.numero).toBe("5491199998888");
    expect(res.body.dentroDeHorario).toBe(true);
  });

  it("fallback POR CAMPO: solo el número en la base, las horas siguen saliendo del entorno", async () => {
    configuracionContactoMock.findUnique.mockResolvedValue({
      id: 1,
      whatsappNumero: "5491199998888",
      whatsappHoraDesde: null,
      whatsappHoraHasta: null,
      whatsappDias: null,
      email: null,
      instagramUrl: null,
      facebookUrl: null,
      tiktokUrl: null,
      direccion: null,
      updatedAt: new Date(),
    });
    // Miércoles 2026-01-07 20:00 ART = 23:00 UTC — fuera del horario de ENTORNO (9-18).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-07T23:00:00.000Z"));

    const res = await request(buildApp()).get("/api/config/whatsapp");

    expect(res.body.numero).toBe("5491199998888");
    expect(res.body.dentroDeHorario).toBe(false);
  });
});

describe("GET /api/config/contacto", () => {
  it("forma pública: whatsapp + email + redes + dirección, null cuando no hay dato", async () => {
    const res = await request(buildApp()).get("/api/config/contacto");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      whatsapp: {
        numero: "5491122334455",
        dentroDeHorario: expect.any(Boolean),
        textoHorario: expect.any(String),
      },
      email: null,
      instagram: null,
      facebook: null,
      tiktok: null,
      direccion: null,
    });
    expect(res.body.crudo).toBeUndefined();
  });

  it("sin token no requiere autenticación", async () => {
    const res = await request(buildApp()).get("/api/config/contacto");
    expect(res.status).not.toBe(401);
  });

  it("con datos en la base, la forma pública los refleja", async () => {
    configuracionContactoMock.findUnique.mockResolvedValue(FILA_DB);

    const res = await request(buildApp()).get("/api/config/contacto");

    expect(res.body.email).toBe("contacto@yima.test");
    expect(res.body.instagram).toBe("https://instagram.com/yima");
    expect(res.body.facebook).toBe("https://facebook.com/yima");
    expect(res.body.tiktok).toBe("https://tiktok.com/@yima");
    expect(res.body.direccion).toBe("Calle Falsa 123");
  });

  // El modo admin sale del TOKEN, nunca de la querystring — mismo criterio
  // que `GET /anuncios` y `GET /products`.
  it("`?admin=1` sin token NO agrega `crudo`", async () => {
    const res = await request(buildApp()).get("/api/config/contacto?admin=1");

    expect(res.status).toBe(200);
    expect(res.body.crudo).toBeUndefined();
  });

  it("con token admin, suma `crudo` con los valores CRUDOS de la base (sin fallback)", async () => {
    configuracionContactoMock.findUnique.mockResolvedValue({
      id: 1,
      whatsappNumero: null,
      whatsappHoraDesde: null,
      whatsappHoraHasta: null,
      whatsappDias: null,
      email: null,
      instagramUrl: null,
      facebookUrl: null,
      tiktokUrl: null,
      direccion: null,
      updatedAt: new Date(),
    });

    const res = await request(buildApp())
      .get("/api/config/contacto")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    // La forma pública igual resuelve el número desde el entorno...
    expect(res.body.whatsapp.numero).toBe("5491122334455");
    // ...pero `crudo` muestra que la base NO tiene nada guardado todavía.
    expect(res.body.crudo).toEqual({
      whatsappNumero: null,
      whatsappHoraDesde: null,
      whatsappHoraHasta: null,
      whatsappDias: null,
      email: null,
      instagramUrl: null,
      facebookUrl: null,
      tiktokUrl: null,
      direccion: null,
    });
  });
});

describe("PUT /api/config/contacto", () => {
  beforeEach(() => {
    configuracionContactoMock.upsert.mockResolvedValue(FILA_DB);
  });

  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).put("/api/config/contacto").send({});

    expect(res.status).toBe(401);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  it("rechaza un whatsappNumero con letras", async () => {
    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ whatsappNumero: "54911abc8888" });

    expect(res.status).toBe(400);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  it("rechaza un whatsappNumero demasiado corto", async () => {
    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ whatsappNumero: "123" });

    expect(res.status).toBe(400);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  it("rechaza horas fuera de 0-23", async () => {
    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ whatsappHoraDesde: 9, whatsappHoraHasta: 24 });

    expect(res.status).toBe(400);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  it("rechaza whatsappHoraDesde >= whatsappHoraHasta cuando vienen los dos", async () => {
    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ whatsappHoraDesde: 18, whatsappHoraHasta: 9 });

    expect(res.status).toBe(400);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  it("rechaza un día fuera de 0-6", async () => {
    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ whatsappDias: "1,2,7" });

    expect(res.status).toBe(400);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  it("rechaza un email con formato inválido", async () => {
    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ email: "no-es-un-email" });

    expect(res.status).toBe(400);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  it("rechaza instagramUrl con http://", async () => {
    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ instagramUrl: "http://instagram.com/yima" });

    expect(res.status).toBe(400);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  it("rechaza facebookUrl con javascript:", async () => {
    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ facebookUrl: "javascript:alert(1)" });

    expect(res.status).toBe(400);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  it("rechaza tiktokUrl con javascript:", async () => {
    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ tiktokUrl: "javascript:alert(1)" });

    expect(res.status).toBe(400);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  it("rechaza una dirección más larga que la columna", async () => {
    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ direccion: "a".repeat(301) });

    expect(res.status).toBe(400);
    expect(configuracionContactoMock.upsert).not.toHaveBeenCalled();
  });

  // Un string vacío significa "bórralo", no "un valor inválido".
  it("un string vacío se guarda como null, no rechaza", async () => {
    configuracionContactoMock.findUnique.mockResolvedValue(FILA_DB);

    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ email: "" });

    expect(res.status).toBe(200);
    expect(configuracionContactoMock.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        update: expect.objectContaining({ email: null }),
      }),
    );
  });

  it("un campo ausente no se toca (no viaja en el upsert)", async () => {
    await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ direccion: "Calle Falsa 123" });

    const llamada = configuracionContactoMock.upsert.mock.calls[0][0];
    expect(llamada.update).not.toHaveProperty("email");
    expect(llamada.update).not.toHaveProperty("whatsappNumero");
    expect(llamada.update.direccion).toBe("Calle Falsa 123");
  });

  it("con datos válidos, actualiza y devuelve la vista admin (con `crudo`)", async () => {
    configuracionContactoMock.findUnique.mockResolvedValue(null);
    configuracionContactoMock.upsert.mockResolvedValue(FILA_DB);

    const res = await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ whatsappNumero: "5491199998888", email: "contacto@yima.test" });

    expect(res.status).toBe(200);
    expect(configuracionContactoMock.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      update: { whatsappNumero: "5491199998888", email: "contacto@yima.test" },
      create: { id: 1, whatsappNumero: "5491199998888", email: "contacto@yima.test" },
    });
    expect(res.body.crudo).toBeDefined();
  });

  it("registra auditoría con anterior/nuevo", async () => {
    configuracionContactoMock.findUnique.mockResolvedValue(null);
    configuracionContactoMock.upsert.mockResolvedValue(FILA_DB);

    await request(buildApp())
      .put("/api/config/contacto")
      .set("Authorization", authHeader)
      .send({ whatsappNumero: "5491199998888" });

    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accion: "ACTUALIZAR", entidad: "ConfiguracionContacto" }),
      }),
    );
  });
});

describe("GET /api/config/home", () => {
  it("null sin producto elegido", async () => {
    configuracionHomeMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/config/home");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ productoIcono: null });
  });

  it("null si el producto elegido ya no está publicado", async () => {
    configuracionHomeMock.findUnique.mockResolvedValue({ id: 1, productoIconoId: 9 });
    productMock.findUnique.mockResolvedValue({ id: 9, visibleEnCatalogo: false });

    const res = await request(buildApp()).get("/api/config/home");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ productoIcono: null });
  });

  it("null si el producto elegido se quedó sin stock", async () => {
    configuracionHomeMock.findUnique.mockResolvedValue({ id: 1, productoIconoId: 9 });
    productMock.findUnique.mockResolvedValue(productoDeDetalle({ visibleEnCatalogo: true, stock: 0 }));

    const res = await request(buildApp()).get("/api/config/home");

    expect(res.body).toEqual({ productoIcono: null });
  });

  it("null si el producto elegido ya no existe (fue borrado)", async () => {
    configuracionHomeMock.findUnique.mockResolvedValue({ id: 1, productoIconoId: 9 });
    productMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp()).get("/api/config/home");

    expect(res.body).toEqual({ productoIcono: null });
  });

  it("con producto publicado, emite el detalle completo", async () => {
    configuracionHomeMock.findUnique.mockResolvedValue({ id: 1, productoIconoId: 9 });
    productMock.findUnique.mockResolvedValue(productoDeDetalle({ id: 9, visibleEnCatalogo: true, stock: 5 }));

    const res = await request(buildApp()).get("/api/config/home");

    expect(res.status).toBe(200);
    expect(res.body.productoIcono).toMatchObject({
      id: 9,
      nombre: "Producto ícono",
      esNuevo: expect.any(Boolean),
    });
    // Nunca filtra costeo — mismo criterio que cualquier lectura pública.
    expect(res.body.productoIcono.costo).toBeUndefined();
    expect(res.body.productoIcono.coeficiente).toBeUndefined();
  });

  it("resuelve el descuento vigente, igual que cualquier vidriera pública", async () => {
    configuracionHomeMock.findUnique.mockResolvedValue({ id: 1, productoIconoId: 9 });
    productMock.findUnique.mockResolvedValue(productoDeDetalle({ id: 9, precio: { toString: () => "1000" } }));
    promocionItemFindManyMock.mockResolvedValue([
      { productId: 9, porcentaje: 10, promocion: { id: 5, nombre: "Liquidación" } },
    ]);

    const res = await request(buildApp()).get("/api/config/home");

    expect(res.body.productoIcono.precioEfectivo).toBe("900");
    expect(res.body.productoIcono.descuento).toEqual({ porcentaje: 10 });
  });

  it("no requiere autenticación", async () => {
    const res = await request(buildApp()).get("/api/config/home");
    expect(res.status).not.toBe(401);
  });
});

describe("PUT /api/config/home", () => {
  it("401 sin token", async () => {
    const res = await request(buildApp()).put("/api/config/home").send({ productoIconoId: 9 });

    expect(res.status).toBe(401);
    expect(configuracionHomeMock.upsert).not.toHaveBeenCalled();
  });

  it("400 si el producto no existe", async () => {
    productMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .put("/api/config/home")
      .set("Authorization", authHeader)
      .send({ productoIconoId: 999 });

    expect(res.status).toBe(400);
    expect(configuracionHomeMock.upsert).not.toHaveBeenCalled();
  });

  it("400 si productoIconoId no es un entero ni null", async () => {
    const res = await request(buildApp())
      .put("/api/config/home")
      .set("Authorization", authHeader)
      .send({ productoIconoId: "nueve" });

    expect(res.status).toBe(400);
    expect(configuracionHomeMock.upsert).not.toHaveBeenCalled();
  });

  it("acepta null para 'ninguno elegido'", async () => {
    configuracionHomeMock.upsert.mockResolvedValue({ id: 1, productoIconoId: null });

    const res = await request(buildApp())
      .put("/api/config/home")
      .set("Authorization", authHeader)
      .send({ productoIconoId: null });

    expect(res.status).toBe(200);
    expect(res.body.productoIcono).toBeNull();
    expect(productMock.findUnique).not.toHaveBeenCalled();
  });

  it("con un producto existente, hace upsert y devuelve el detalle actualizado sin un segundo GET", async () => {
    productMock.findUnique.mockResolvedValue(productoDeDetalle({ id: 9 }));
    configuracionHomeMock.upsert.mockResolvedValue({ id: 1, productoIconoId: 9 });

    const res = await request(buildApp())
      .put("/api/config/home")
      .set("Authorization", authHeader)
      .send({ productoIconoId: 9 });

    expect(res.status).toBe(200);
    expect(configuracionHomeMock.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: { id: 1, productoIconoId: 9 },
      update: { productoIconoId: 9 },
    });
    expect(res.body.productoIcono).toMatchObject({ id: 9 });
    // Un solo `findUnique` para validar existencia: la escritura reutiliza
    // ESA fila para armar la respuesta, no dispara una segunda consulta.
    expect(productMock.findUnique).toHaveBeenCalledTimes(1);
  });

  it("registra auditoría con el productoIconoId elegido", async () => {
    productMock.findUnique.mockResolvedValue(productoDeDetalle({ id: 9 }));
    configuracionHomeMock.upsert.mockResolvedValue({ id: 1, productoIconoId: 9 });

    await request(buildApp())
      .put("/api/config/home")
      .set("Authorization", authHeader)
      .send({ productoIconoId: 9 });

    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accion: "ACTUALIZAR",
          entidad: "ConfiguracionHome",
          entidadId: 1,
        }),
      }),
    );
  });
});
