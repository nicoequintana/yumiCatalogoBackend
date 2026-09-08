import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const promocionMock = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const promocionItemMock = { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn(), update: vi.fn() };
const programacionMock = { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() };
const productMock = { findMany: vi.fn(), count: vi.fn() };
const ordenMock = { findMany: vi.fn() };
const usuarioFindUniqueMock = vi.fn();
const auditCreateMock = vi.fn();
const transactionMock = vi.fn();
const subirArchivoMock = vi.fn();
const eliminarArchivoMock = vi.fn();
const eventoTraficoCreateMock = vi.fn();

vi.mock("../services/cloudinary.service.js", () => ({
  subirArchivo: (...args) => subirArchivoMock(...args),
  eliminarArchivo: (...args) => eliminarArchivoMock(...args),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    promocion: {
      findMany: (...a) => promocionMock.findMany(...a),
      findUnique: (...a) => promocionMock.findUnique(...a),
      create: (...a) => promocionMock.create(...a),
      update: (...a) => promocionMock.update(...a),
      delete: (...a) => promocionMock.delete(...a),
    },
    promocionItem: {
      findMany: (...a) => promocionItemMock.findMany(...a),
      deleteMany: (...a) => promocionItemMock.deleteMany(...a),
      createMany: (...a) => promocionItemMock.createMany(...a),
      update: (...a) => promocionItemMock.update(...a),
    },
    programacionPromocion: {
      findMany: (...a) => programacionMock.findMany(...a),
      findUnique: (...a) => programacionMock.findUnique(...a),
      create: (...a) => programacionMock.create(...a),
      update: (...a) => programacionMock.update(...a),
      delete: (...a) => programacionMock.delete(...a),
    },
    product: {
      findMany: (...a) => productMock.findMany(...a),
      count: (...a) => productMock.count(...a),
    },
    orden: { findMany: (...a) => ordenMock.findMany(...a) },
    usuario: { findUnique: (...a) => usuarioFindUniqueMock(...a) },
    auditLog: { create: (...a) => auditCreateMock(...a) },
    $transaction: (...a) => transactionMock(...a),
    eventoTrafico: { create: (...a) => eventoTraficoCreateMock(...a) },
  },
}));

const { default: promocionesRouter } = await import("./promociones.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/promociones", promocionesRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "3650d",
});
const authHeader = `Bearer ${token}`;

function promo(extra = {}) {
  return {
    id: 3,
    nombre: "Promo Hogar",
    descripcion: null,
    activa: true,
    items: [
      {
        id: 1,
        productId: 21,
        porcentaje: 15,
        habilitado: true,
        product: { id: 21, nombre: "Velador LED", sku: "YIMA-1", precio: { toString: () => "20000" } },
      },
    ],
    programaciones: [],
    campanias: [],
    createdAt: new Date("2026-09-01"),
    updatedAt: new Date("2026-09-01"),
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
  eventoTraficoCreateMock.mockReset();
  // Defaults EXPLÍCITOS: `vi.clearAllMocks()` limpia las llamadas pero NO los
  // `mockResolvedValue`, así que sin esto un test hereda la respuesta del
  // anterior — y con una forma distinta, que es peor que sin respuesta.
  promocionMock.findMany.mockResolvedValue([]);
  promocionItemMock.findMany.mockResolvedValue([]);
  programacionMock.findMany.mockResolvedValue([]);
  promocionItemMock.deleteMany.mockResolvedValue({ count: 0 });
  promocionItemMock.createMany.mockResolvedValue({ count: 0 });
  productMock.findMany.mockResolvedValue([]);
  productMock.count.mockResolvedValue(0);
  ordenMock.findMany.mockResolvedValue([]);
  subirArchivoMock.mockResolvedValue({
    url: "https://res.cloudinary.com/demo/arte-nuevo.jpg",
    cloudinaryPublicId: "test/campanias/arte-nuevo",
    cloudinaryResourceType: "image",
  });
  eliminarArchivoMock.mockResolvedValue(undefined);
  transactionMock.mockImplementation(async (arg) =>
    typeof arg === "function"
      ? arg({
          promocionItem: {
            deleteMany: (...a) => promocionItemMock.deleteMany(...a),
            createMany: (...a) => promocionItemMock.createMany(...a),
          },
        })
      : Promise.all(arg),
  );
});

describe("seguridad", () => {
  it("TODAS las rutas exigen auth: es un módulo del panel entero", async () => {
    const app = buildApp();
    const rutas = [
      ["get", "/api/promociones"],
      ["get", "/api/promociones/productos"],
      ["get", "/api/promociones/3"],
      ["post", "/api/promociones"],
      ["put", "/api/promociones/3"],
      ["put", "/api/promociones/3/items"],
      ["put", "/api/promociones/3/arte"],
      ["delete", "/api/promociones/3/arte"],
      ["delete", "/api/promociones/3"],
    ];

    for (const [metodo, ruta] of rutas) {
      const res = await request(app)[metodo](ruta);
      expect(res.status, `${metodo.toUpperCase()} ${ruta}`).toBe(401);
    }
  });

  it("eliminar exige además el permiso de borrado", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: false });
    promocionMock.findUnique.mockResolvedValue(promo());

    const res = await request(buildApp())
      .delete("/api/promociones/3")
      .set("Authorization", authHeader);

    expect(res.status).toBe(403);
    expect(promocionMock.delete).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/promociones/:id", () => {
  // Mismo criterio que "DELETE /api/promociones/:id/arte": el archivo remoto
  // se borra DESPUÉS de que la fila se fue, y solo si había uno.
  it("borra el arte en Cloudinary de una promoción CON arte", async () => {
    promocionMock.findUnique.mockResolvedValue(
      promo({ id: 3, bannerArteCloudinaryPublicId: "pid", bannerArteCloudinaryResourceType: "image" }),
    );
    promocionMock.delete.mockResolvedValue(promo({ id: 3 }));

    const res = await request(buildApp()).delete("/api/promociones/3").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(promocionMock.delete).toHaveBeenCalledWith({ where: { id: 3 } });
    expect(eliminarArchivoMock).toHaveBeenCalledWith("pid", "image");
  });

  it("una promoción SIN arte no intenta borrar nada en Cloudinary", async () => {
    promocionMock.findUnique.mockResolvedValue(promo({ id: 3, bannerArteCloudinaryPublicId: null }));
    promocionMock.delete.mockResolvedValue(promo({ id: 3 }));

    const res = await request(buildApp()).delete("/api/promociones/3").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(eliminarArchivoMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/promociones", () => {
  it("emite cada promoción con cuántos productos tiene y si está programada", async () => {
    // Son las dos preguntas que se hacen mirando la lista: a cuántos alcanza, y
    // si está haciendo algo hoy. Sin ellas hay que abrir cada una.
    promocionMock.findMany.mockResolvedValue([promo()]);

    const res = await request(buildApp()).get("/api/promociones").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      id: 3,
      nombre: "Promo Hogar",
      cantidadProductos: 1,
      programada: false,
    });
  });

  it("una promoción con programación vigente figura como programada", async () => {
    promocionMock.findMany.mockResolvedValue([
      promo({ programaciones: [{ id: 1, habilitada: true }] }),
    ]);

    const res = await request(buildApp()).get("/api/promociones").set("Authorization", authHeader);

    expect(res.body[0].programada).toBe(true);
  });

  it("NO emite los items en el listado", async () => {
    // El listado es una grilla: traer todos los productos de todas las
    // promociones sería un payload que crece sin techo. Están en el detalle.
    promocionMock.findMany.mockResolvedValue([promo()]);

    const res = await request(buildApp()).get("/api/promociones").set("Authorization", authHeader);

    expect(res.body[0].items).toBeUndefined();
  });
});

describe("GET /api/promociones/:id — el detalle", () => {
  it("emite cada producto con su porcentaje y el precio resultante", async () => {
    // El precio promocional se muestra en el panel para que el admin vea a
    // cuánto queda ANTES de programar. Lo calcula el backend, no la pantalla.
    promocionMock.findUnique.mockResolvedValue(promo());

    const res = await request(buildApp()).get("/api/promociones/3").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      productId: 21,
      nombre: "Velador LED",
      porcentaje: 15,
      precio: "20000",
      precioPromocional: "17000",
      habilitado: true,
    });
  });

  it("una promoción inexistente da 404", async () => {
    promocionMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .get("/api/promociones/99")
      .set("Authorization", authHeader);

    expect(res.status).toBe(404);
  });
});

describe("POST /api/promociones — validaciones", () => {
  function crear(body) {
    return request(buildApp()).post("/api/promociones").set("Authorization", authHeader).send(body);
  }

  it("crea con nombre", async () => {
    promocionMock.create.mockResolvedValue(promo({ items: [] }));

    const res = await crear({ nombre: "Promo Hogar" });

    expect(res.status).toBe(201);
    expect(auditCreateMock).toHaveBeenCalled();
  });

  it("rechaza el nombre vacío", async () => {
    expect((await crear({ nombre: "  " })).status).toBe(400);
  });

  it("NO acepta fechas: las fechas son del calendario", async () => {
    // Es el eje del módulo. Aceptar una fecha acá, aunque fuera para
    // ignorarla, le enseñaría a un llamador que este endpoint programa.
    const res = await crear({ nombre: "X", desde: "2026-09-01", hasta: "2026-09-30" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/calendario/i);
  });
});

describe("PUT /api/promociones/:id — el banner de la home", () => {
  it("guarda los textos y el interruptor", async () => {
    promocionMock.findUnique.mockResolvedValue(promo());
    promocionMock.update.mockResolvedValue(
      promo({ bannerEnHome: true, bannerTitulo: "Semana del Hogar" }),
    );

    const res = await request(buildApp())
      .put("/api/promociones/3")
      .set("Authorization", authHeader)
      .send({
        nombre: "Hogar",
        bannerEnHome: true,
        bannerTitulo: "Semana del Hogar",
        bannerTexto: "Hasta 30% off",
      });

    expect(res.status).toBe(200);
    expect(promocionMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bannerEnHome: true,
          bannerTitulo: "Semana del Hogar",
          bannerTexto: "Hasta 30% off",
        }),
      }),
    );
  });

  it("rechaza el marcador {dias}, que es del cartel de campañas", async () => {
    promocionMock.findUnique.mockResolvedValue(promo());

    const res = await request(buildApp())
      .put("/api/promociones/3")
      .set("Authorization", authHeader)
      .send({ nombre: "Hogar", bannerTitulo: "Faltan {dias} días" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("{dias}");
  });

  it("un banner prendido sin título es 400", async () => {
    promocionMock.findUnique.mockResolvedValue(promo());

    const res = await request(buildApp())
      .put("/api/promociones/3")
      .set("Authorization", authHeader)
      .send({ nombre: "Hogar", bannerEnHome: true, bannerTitulo: "" });

    expect(res.status).toBe(400);
  });

  it("un body con bannerColor o bannerCtaTexto ya no cambia nada", async () => {
    // Dejaron de ser decisiones editables (06/09/2026): el slide entero es el
    // enlace, su copy es fijo y el molde sin arte va en el color de marca. El
    // body se ACEPTA —una pestaña vieja del panel los sigue mandando— pero no
    // llega al `data`: las dos columnas quedan inertes con lo que ya tenían.
    promocionMock.findUnique.mockResolvedValue(promo());
    promocionMock.update.mockResolvedValue(promo());

    const res = await request(buildApp())
      .put("/api/promociones/3")
      .set("Authorization", authHeader)
      .send({ nombre: "Hogar", bannerColor: "FUCSIA", bannerCtaTexto: "Ver ofertas" });

    expect(res.status).toBe(200);
    const { data } = promocionMock.update.mock.calls[0][0];
    expect(data).not.toHaveProperty("bannerColor");
    expect(data).not.toHaveProperty("bannerCtaTexto");
  });

  it("un PUT parcial (solo `nombre`) conserva título y texto ya guardados", async () => {
    // Clave AUSENTE del body = "no lo toques". Sin esto, cualquier edición de
    // nombre o de items que no reenvíe el banner completo lo vacía, mismo bug
    // que `AdminCategorias.jsx` vaciando `icono` al renombrar sin mandarlo.
    promocionMock.findUnique.mockResolvedValue(
      promo({
        bannerTitulo: "Semana del Hogar",
        bannerTexto: "Hasta 30% off",
      }),
    );
    promocionMock.update.mockResolvedValue(promo());

    const res = await request(buildApp())
      .put("/api/promociones/3")
      .set("Authorization", authHeader)
      .send({ nombre: "Hogar" });

    expect(res.status).toBe(200);
    expect(promocionMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bannerTitulo: "Semana del Hogar",
          bannerTexto: "Hasta 30% off",
        }),
      }),
    );
  });

  it("un PUT parcial sobre un banner ya prendido con título no explota en 400", async () => {
    promocionMock.findUnique.mockResolvedValue(
      promo({ bannerEnHome: true, bannerTitulo: "Semana del Hogar" }),
    );
    promocionMock.update.mockResolvedValue(promo({ bannerEnHome: true, bannerTitulo: "Semana del Hogar" }));

    const res = await request(buildApp())
      .put("/api/promociones/3")
      .set("Authorization", authHeader)
      .send({ nombre: "Hogar" });

    expect(res.status).toBe(200);
  });

  it("`bannerTitulo: null` explícito SÍ borra el título (ausente ≠ null)", async () => {
    promocionMock.findUnique.mockResolvedValue(promo({ bannerTitulo: "Semana del Hogar" }));
    promocionMock.update.mockResolvedValue(promo({ bannerTitulo: null }));

    const res = await request(buildApp())
      .put("/api/promociones/3")
      .set("Authorization", authHeader)
      .send({ nombre: "Hogar", bannerTitulo: null });

    expect(res.status).toBe(200);
    expect(promocionMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bannerTitulo: null }),
      }),
    );
  });
});

describe("PUT /api/promociones/:id/arte y DELETE /api/promociones/:id/arte", () => {
  /** Un JPEG mínimo: la firma real (`FF D8 FF`), para que `contenidoCoincideConMime` lo acepte. */
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

  function subir(buffer, nombre, tipo) {
    return request(buildApp())
      .put("/api/promociones/3/arte")
      .set("Authorization", authHeader)
      .attach("arte", buffer, { filename: nombre, contentType: tipo });
  }

  it("sube el arte y guarda las tres columnas", async () => {
    promocionMock.findUnique.mockResolvedValue(promo({ id: 3 }));
    promocionMock.update.mockResolvedValue(promo({ id: 3, bannerArteUrl: "https://cdn/x.jpg" }));

    const res = await subir(JPEG, "a.jpg", "image/jpeg");

    expect(res.status).toBe(200);
    expect(promocionMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bannerArteUrl: expect.any(String),
          bannerArteCloudinaryPublicId: expect.any(String),
          bannerArteCloudinaryResourceType: expect.any(String),
        }),
      }),
    );
  });

  it("borra el archivo anterior en Cloudinary DESPUÉS de guardar el nuevo", async () => {
    promocionMock.findUnique.mockResolvedValue(
      promo({ id: 3, bannerArteCloudinaryPublicId: "test/campanias/viejo" }),
    );
    promocionMock.update.mockResolvedValue(promo({ id: 3, bannerArteUrl: "https://cdn/x.jpg" }));

    const res = await subir(JPEG, "a.jpg", "image/jpeg");

    expect(res.status).toBe(200);
    expect(eliminarArchivoMock).toHaveBeenCalledWith("test/campanias/viejo", "image");
  });

  it("una promoción sin arte previo no intenta borrar nada al subir uno nuevo", async () => {
    promocionMock.findUnique.mockResolvedValue(promo({ id: 3, bannerArteCloudinaryPublicId: null }));
    promocionMock.update.mockResolvedValue(promo({ id: 3, bannerArteUrl: "https://cdn/x.jpg" }));

    await subir(JPEG, "a.jpg", "image/jpeg");

    expect(eliminarArchivoMock).not.toHaveBeenCalled();
  });

  it("sin archivo responde 400", async () => {
    promocionMock.findUnique.mockResolvedValue(promo({ id: 3 }));

    const res = await request(buildApp()).put("/api/promociones/3/arte").set("Authorization", authHeader);

    expect(res.status).toBe(400);
    expect(subirArchivoMock).not.toHaveBeenCalled();
  });

  it("rechaza un tipo no permitido con 400, no con 500", async () => {
    // Lo corta el `fileFilter` de multer. Sin el `err.status = 400` explícito,
    // un MulterError sale por el error handler como 500 opaco.
    const res = await subir(Buffer.from("GIF89a"), "a.gif", "image/gif");

    expect(res.status).toBe(400);
    expect(subirArchivoMock).not.toHaveBeenCalled();
  });

  it("rechaza un archivo cuyos BYTES no son los de su mime declarado", async () => {
    // Defensa en profundidad: el mimetype lo declara el cliente y es
    // falsificable. Nada llega a Cloudinary sin que los bytes coincidan.
    promocionMock.findUnique.mockResolvedValue(promo({ id: 3 }));

    const res = await subir(Buffer.from("no soy una imagen"), "a.jpg", "image/jpeg");

    expect(res.status).toBe(400);
    expect(subirArchivoMock).not.toHaveBeenCalled();
  });

  it("una promoción inexistente da 404 y no sube nada", async () => {
    promocionMock.findUnique.mockResolvedValue(null);

    const res = await subir(JPEG, "a.jpg", "image/jpeg");

    expect(res.status).toBe(404);
    expect(subirArchivoMock).not.toHaveBeenCalled();
  });

  it("borra el arte y deja las tres columnas en null", async () => {
    promocionMock.findUnique.mockResolvedValue(promo({ id: 3, bannerArteCloudinaryPublicId: "pid" }));
    promocionMock.update.mockResolvedValue(promo({ id: 3 }));

    const res = await request(buildApp()).delete("/api/promociones/3/arte").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(promocionMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          bannerArteUrl: null,
          bannerArteCloudinaryPublicId: null,
          bannerArteCloudinaryResourceType: null,
        },
      }),
    );
    expect(eliminarArchivoMock).toHaveBeenCalledWith("pid", "image");
  });

  it("una promoción sin arte no intenta borrar nada al quitarlo", async () => {
    promocionMock.findUnique.mockResolvedValue(promo({ id: 3, bannerArteCloudinaryPublicId: null }));
    promocionMock.update.mockResolvedValue(promo({ id: 3 }));

    await request(buildApp()).delete("/api/promociones/3/arte").set("Authorization", authHeader);

    expect(eliminarArchivoMock).not.toHaveBeenCalled();
  });

  it("una promoción inexistente da 404 al quitar el arte", async () => {
    promocionMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp()).delete("/api/promociones/99/arte").set("Authorization", authHeader);

    expect(res.status).toBe(404);
  });
});

describe("PUT /api/promociones/:id/items — los productos y sus porcentajes", () => {
  function guardar(items) {
    return request(buildApp())
      .put("/api/promociones/3/items")
      .set("Authorization", authHeader)
      .send({ items });
  }

  beforeEach(() => {
    promocionMock.findUnique.mockResolvedValue(promo());
    promocionItemMock.deleteMany.mockResolvedValue({ count: 1 });
    promocionItemMock.createMany.mockResolvedValue({ count: 2 });
  });

  it("guarda cada producto con SU porcentaje", async () => {
    productMock.findMany.mockResolvedValue([{ id: 21 }, { id: 22 }]);

    const res = await guardar([
      { productId: 21, porcentaje: 10 },
      { productId: 22, porcentaje: 20 },
    ]);

    expect(res.status).toBe(200);
    const { data } = promocionItemMock.createMany.mock.calls[0][0];
    expect(data).toEqual([
      { promocionId: 3, productId: 21, porcentaje: 10 },
      { promocionId: 3, productId: 22, porcentaje: 20 },
    ]);
  });

  it("rechaza un porcentaje fuera del rango 5-50", async () => {
    for (const invalido of [0, 4, 51, -10, 12.5]) {
      const res = await guardar([{ productId: 21, porcentaje: invalido }]);
      expect(res.status, `porcentaje: ${invalido}`).toBe(400);
    }
    expect(promocionItemMock.createMany).not.toHaveBeenCalled();
  });

  it("rechaza un producto repetido", async () => {
    // Cuál de los dos porcentajes gana no tendría respuesta. La base también lo
    // impide con un unique, pero el 400 explica y el P2002 no.
    const res = await guardar([
      { productId: 21, porcentaje: 10 },
      { productId: 21, porcentaje: 20 },
    ]);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/repetido/i);
  });

  it("rechaza un producto que no existe", async () => {
    productMock.findMany.mockResolvedValue([{ id: 21 }]);

    const res = await guardar([
      { productId: 21, porcentaje: 10 },
      { productId: 999, porcentaje: 20 },
    ]);

    expect(res.status).toBe(400);
    expect(promocionItemMock.createMany).not.toHaveBeenCalled();
  });

  it("reemplaza la lista COMPLETA en una transacción", async () => {
    // Aplicada a medias dejaría una promoción con la mitad vieja y la mitad
    // nueva, que es un descuento que nadie pidió.
    productMock.findMany.mockResolvedValue([{ id: 21 }]);

    await guardar([{ productId: 21, porcentaje: 10 }]);

    expect(transactionMock).toHaveBeenCalled();
    expect(promocionItemMock.deleteMany).toHaveBeenCalledWith({ where: { promocionId: 3 } });
  });

  it("una lista VACÍA es válida: deja la promoción sin productos", async () => {
    productMock.findMany.mockResolvedValue([]);
    // Vaciar una promoción es una operación legítima, y es distinta de
    // borrarla: se conservan sus programaciones y su nombre.
    const res = await guardar([]);

    expect(res.status).toBe(200);
    expect(promocionItemMock.deleteMany).toHaveBeenCalled();
  });
});

describe("PATCH /api/promociones/:id/items/:productId — el override del conflicto", () => {
  it("apaga un producto dentro de una promoción sin tocar el resto", async () => {
    promocionMock.findUnique.mockResolvedValue(promo());
    promocionItemMock.findMany.mockResolvedValue([{ id: 1, promocionId: 3, productId: 21 }]);
    promocionItemMock.update.mockResolvedValue({ id: 1, habilitado: false });

    const res = await request(buildApp())
      .patch("/api/promociones/3/items/21")
      .set("Authorization", authHeader)
      .send({ habilitado: false });

    expect(res.status).toBe(200);
    expect(promocionItemMock.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { habilitado: false } }),
    );
  });

  it("rechaza un valor que no es booleano", async () => {
    promocionMock.findUnique.mockResolvedValue(promo());

    const res = await request(buildApp())
      .patch("/api/promociones/3/items/21")
      .set("Authorization", authHeader)
      .send({ habilitado: "no" });

    expect(res.status).toBe(400);
  });
});

describe("GET /api/promociones/productos — el listado comercial", () => {
  const FILA = {
    id: 21,
    sku: "YIMA-1",
    nombre: "Velador LED",
    precio: { toString: () => "20000" },
    costo: { toString: () => "8000" },
    coeficiente: { toString: () => "2.50" },
    etiqueta: null,
    visibleEnCatalogo: true,
    stock: 4,
    destacado: false,
    vistas: 120,
    compartidos: 2,
    categoria: { id: 1, nombre: "Hogar" },
    fotos: [{ id: 9, url: "https://res.cloudinary.com/x.png", orden: 0, cloudinaryPublicId: "x" }],
    _count: { fotos: 1 },
  };

  beforeEach(() => {
    productMock.findMany.mockResolvedValue([FILA]);
    productMock.count.mockResolvedValue(1);
  });

  it("cruza vistas y VENTAS, que hoy ningún endpoint junta", async () => {
    // Las ventas salen de agregar `Orden.items` en memoria: Prisma no sabe
    // sumar la expresión `precioUnitario * cantidad`.
    ordenMock.findMany.mockResolvedValue([
      { estado: "ENTREGADA", items: [{ productId: 21, cantidad: 3, precioUnitario: "20000" }] },
      { estado: "EN_PREPARACION", items: [{ productId: 21, cantidad: 1, precioUnitario: "20000" }] },
    ]);

    const res = await request(buildApp())
      .get("/api/promociones/productos")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      id: 21,
      nombre: "Velador LED",
      vistas: 120,
      unidadesVendidas: 4,
      costo: "8000",
      coeficiente: "2.50",
      precio: "20000",
    });
  });

  it("una orden CANCELADA no cuenta como venta", async () => {
    // Se afirma sobre el WHERE y no sobre el resultado: quien filtra las
    // canceladas es la consulta, y en un test con Prisma mockeado el filtro no
    // corre. Afirmar sobre el resultado sería un test que pasa por el mock, no
    // por el código — de los que no pueden fallar cuando la regla se rompe.
    await request(buildApp()).get("/api/promociones/productos").set("Authorization", authHeader);

    const { where } = ordenMock.findMany.mock.calls[0][0];
    expect(where.estado.in).toEqual(["EN_PREPARACION", "ENTREGADA"]);
    expect(where.estado.in).not.toContain("CANCELADA");
    expect(where.estado.in).not.toContain("PENDIENTE");
  });

  it("emite la conversión, para detectar mucha vista y poca venta", async () => {
    // El §18 del pedido. Se resuelve con un número derivado, no con IA.
    ordenMock.findMany.mockResolvedValue([
      { estado: "ENTREGADA", items: [{ productId: 21, cantidad: 3, precioUnitario: "20000" }] },
    ]);

    const res = await request(buildApp())
      .get("/api/promociones/productos")
      .set("Authorization", authHeader);

    // 3 de 120 vistas = 2,5 %
    expect(res.body.data[0].conversion).toBeCloseTo(2.5, 1);
  });

  it("sin vistas la conversión es null, NUNCA cero", async () => {
    // Cero diría "nadie de los que lo vieron compró", y nadie lo vio. Es la
    // misma distinción que `costoUnitario: null` vs. margen 0.
    productMock.findMany.mockResolvedValue([{ ...FILA, vistas: 0 }]);

    const res = await request(buildApp())
      .get("/api/promociones/productos")
      .set("Authorization", authHeader);

    expect(res.body.data[0].conversion).toBeNull();
  });

  it("emite en qué promociones está cada producto", async () => {
    promocionItemMock.findMany.mockResolvedValue([
      { productId: 21, porcentaje: 15, promocion: { id: 3, nombre: "Promo Hogar" } },
    ]);

    const res = await request(buildApp())
      .get("/api/promociones/productos")
      .set("Authorization", authHeader);

    expect(res.body.data[0].promociones).toEqual([
      { id: 3, nombre: "Promo Hogar", porcentaje: 15 },
    ]);
  });

  it("filtra por categoría cuando viene ?categoria=", async () => {
    await request(buildApp())
      .get("/api/promociones/productos?categoria=7")
      .set("Authorization", authHeader);

    const { where } = productMock.findMany.mock.calls[0][0];
    expect(where.categoriaId).toBe(7);
  });

  it("filtra por etiqueta cuando viene ?etiqueta=", async () => {
    await request(buildApp())
      .get("/api/promociones/productos?etiqueta=5")
      .set("Authorization", authHeader);

    const { where } = productMock.findMany.mock.calls[0][0];
    expect(where.etiquetaId).toBe(5);
  });

  it("un id de categoría 0 o negativo no arma ningún filtro (parsearIdEntero los descarta)", async () => {
    for (const invalido of ["0", "-3"]) {
      productMock.findMany.mockClear();
      await request(buildApp())
        .get(`/api/promociones/productos?categoria=${invalido}`)
        .set("Authorization", authHeader);
      const { where } = productMock.findMany.mock.calls[0][0];
      expect(where.categoriaId, `categoria=${invalido}`).toBeUndefined();
    }
  });

  it("un id de etiqueta 0 o negativo no arma ningún filtro", async () => {
    for (const invalido of ["0", "-3"]) {
      productMock.findMany.mockClear();
      await request(buildApp())
        .get(`/api/promociones/productos?etiqueta=${invalido}`)
        .set("Authorization", authHeader);
      const { where } = productMock.findMany.mock.calls[0][0];
      expect(where.etiquetaId, `etiqueta=${invalido}`).toBeUndefined();
    }
  });

  it("un id de categoría fuera del rango representable (1e21) no revienta y no filtra", async () => {
    // `Number.isInteger(1e21)` da `true` —es un entero perfectamente válido
    // para JS— pero excede el entero de 64 bits de SQL Server y Prisma
    // revienta con un 500 real. `parsearIdEntero` lo descarta.
    await request(buildApp())
      .get("/api/promociones/productos?categoria=1e21")
      .set("Authorization", authHeader);

    const { where } = productMock.findMany.mock.calls[0][0];
    expect(where.categoriaId).toBeUndefined();
  });

  it("un id de etiqueta fuera del rango representable (1e21) no revienta y no filtra", async () => {
    await request(buildApp())
      .get("/api/promociones/productos?etiqueta=1e21")
      .set("Authorization", authHeader);

    const { where } = productMock.findMany.mock.calls[0][0];
    expect(where.etiquetaId).toBeUndefined();
  });

  it("devuelve el sobre paginado del proyecto", async () => {
    const res = await request(buildApp())
      .get("/api/promociones/productos")
      .set("Authorization", authHeader);

    expect(res.body).toMatchObject({ page: 1, total: 1 });
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it("las ventas se agregan SOLO sobre los productos de la página", async () => {
    // Recorrer el histórico entero para pintar veinte filas sería traerse
    // 20.000 órdenes en cada carga de la pantalla.
    await request(buildApp()).get("/api/promociones/productos").set("Authorization", authHeader);

    const { where } = ordenMock.findMany.mock.calls[0][0];
    expect(where.items.some.productId).toEqual({ in: [21] });
  });
});

/**
 * Guard de la PROGRAMACIÓN, que es lo que hace que una promoción le llegue a
 * alguien. Sin esto, el módulo entero es una lista de intenciones.
 */
describe("programaciones — el calendario es el que programa", () => {
  beforeEach(() => {
    promocionMock.findUnique.mockResolvedValue(promo());
    programacionMock.create.mockResolvedValue({
      id: 5,
      promocionId: 3,
      desde: new Date("2026-09-10T03:00:00.000Z"),
      hasta: new Date("2026-09-20T03:00:00.000Z"),
      habilitada: true,
    });
  });

  function programar(body) {
    return request(buildApp())
      .post("/api/promociones/3/programaciones")
      .set("Authorization", authHeader)
      .send(body);
  }

  it("guarda las fechas como la medianoche ARGENTINA de su día", async () => {
    const res = await programar({ desde: "2026-09-10", hasta: "2026-09-20" });

    expect(res.status).toBe(201);
    const { data } = programacionMock.create.mock.calls[0][0];
    // La medianoche del 10 en Buenos Aires es el 10 a las 03:00 UTC.
    expect(data.desde.toISOString()).toBe("2026-09-10T03:00:00.000Z");
    expect(data.hasta.toISOString()).toBe("2026-09-20T03:00:00.000Z");
  });

  it("rechaza inicio posterior al fin", async () => {
    const res = await programar({ desde: "2026-09-20", hasta: "2026-09-10" });

    expect(res.status).toBe(400);
    expect(programacionMock.create).not.toHaveBeenCalled();
  });

  it("acepta un solo día", async () => {
    expect((await programar({ desde: "2026-12-25", hasta: "2026-12-25" })).status).toBe(201);
  });

  it("rechaza una fecha ilegible", async () => {
    expect((await programar({ desde: "10/09/2026", hasta: "2026-09-20" })).status).toBe(400);
  });

  it("nace HABILITADA: programar es querer que se aplique", async () => {
    await programar({ desde: "2026-09-10", hasta: "2026-09-20" });

    expect(programacionMock.create.mock.calls[0][0].data.habilitada).toBe(true);
  });

  it("PATCH apaga una programación sin borrarla ni tocar sus fechas", async () => {
    // El OFF manual del §24: la promoción deja de aplicarse en el acto, y el
    // período queda para volver a prenderla.
    programacionMock.findUnique.mockResolvedValue({ id: 5, promocionId: 3 });
    // La fila COMPLETA: Prisma siempre devuelve las fechas, y un mock que las
    // omite prueba una forma que la base nunca produce.
    programacionMock.update.mockResolvedValue({
      id: 5,
      promocionId: 3,
      desde: new Date("2026-09-10T03:00:00.000Z"),
      hasta: new Date("2026-09-20T03:00:00.000Z"),
      habilitada: false,
    });

    const res = await request(buildApp())
      .patch("/api/promociones/programaciones/5")
      .set("Authorization", authHeader)
      .send({ habilitada: false });

    expect(res.status).toBe(200);
    expect(programacionMock.update.mock.calls[0][0].data).toEqual({ habilitada: false });
  });

  it("DELETE borra la programación, no la promoción", async () => {
    programacionMock.findUnique.mockResolvedValue({ id: 5, promocionId: 3 });
    programacionMock.delete.mockResolvedValue({ id: 5 });

    const res = await request(buildApp())
      .delete("/api/promociones/programaciones/5")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(promocionMock.delete).not.toHaveBeenCalled();
  });

  it("el listado del mes trae las programaciones que SOLAPAN, no solo las contenidas", async () => {
    // Una programación de agosto a octubre ocupa septiembre y tiene que
    // aparecer al mirar ese mes.
    programacionMock.findMany.mockResolvedValue([]);

    await request(buildApp())
      .get("/api/promociones/programaciones?desde=2026-09-01&hasta=2026-09-30")
      .set("Authorization", authHeader);

    const { where } = programacionMock.findMany.mock.calls[0][0];
    expect(where.desde.lte.toISOString()).toBe("2026-09-30T03:00:00.000Z");
    expect(where.hasta.gte.toISOString()).toBe("2026-09-01T03:00:00.000Z");
  });

  it("el listado emite el nombre de la promoción, para el calendario", async () => {
    // §22: una promoción programada tiene que identificarse en el calendario
    // sin abrir el detalle.
    programacionMock.findMany.mockResolvedValue([
      {
        id: 5,
        desde: new Date("2026-09-10T03:00:00.000Z"),
        hasta: new Date("2026-09-15T03:00:00.000Z"),
        habilitada: true,
        promocion: { id: 3, nombre: "Velador 10% OFF", activa: true },
      },
    ]);

    const res = await request(buildApp())
      .get("/api/promociones/programaciones?desde=2026-09-01&hasta=2026-09-30")
      .set("Authorization", authHeader);

    expect(res.body[0]).toMatchObject({
      id: 5,
      promocionId: 3,
      nombre: "Velador 10% OFF",
      desde: "2026-09-10",
      hasta: "2026-09-15",
      habilitada: true,
    });
  });
});

describe("GET /api/promociones/conflictos", () => {
  it("arma la forma que la detección necesita y emite el resultado", async () => {
    promocionMock.findMany.mockResolvedValue([
      {
        id: 1,
        nombre: "Promo Velador",
        items: [
          { productId: 10, porcentaje: 10, habilitado: true, product: { nombre: "Velador LED" } },
        ],
        programaciones: [
          { desde: new Date("2026-09-01T03:00:00Z"), hasta: new Date("2026-09-30T03:00:00Z"), habilitada: true },
        ],
        campanias: [],
      },
      {
        id: 2,
        nombre: "Primavera",
        items: [
          { productId: 10, porcentaje: 20, habilitado: true, product: { nombre: "Velador LED" } },
        ],
        programaciones: [],
        campanias: [
          {
            campania: {
              estado: "HABILITADA",
              desde: new Date("2026-09-10T03:00:00Z"),
              hasta: new Date("2026-09-20T03:00:00Z"),
            },
          },
        ],
      },
    ]);

    const res = await request(buildApp())
      .get("/api/promociones/conflictos")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      productId: 10,
      nombreProducto: "Velador LED",
      predominaId: 1,
    });
  });

  it("una campaña APAGADA no aporta período: sus promociones no conflictúan", async () => {
    // Apagar la campaña apaga sus promociones, así que dejan de competir. Si
    // siguieran figurando, la alerta pediría resolver algo que no está pasando.
    promocionMock.findMany.mockResolvedValue([
      {
        id: 1,
        nombre: "A",
        items: [{ productId: 10, porcentaje: 10, habilitado: true, product: { nombre: "X" } }],
        programaciones: [
          { desde: new Date("2026-09-01T03:00:00Z"), hasta: new Date("2026-09-30T03:00:00Z"), habilitada: true },
        ],
        campanias: [],
      },
      {
        id: 2,
        nombre: "B",
        items: [{ productId: 10, porcentaje: 20, habilitado: true, product: { nombre: "X" } }],
        programaciones: [],
        campanias: [
          {
            campania: {
              estado: "DESHABILITADA",
              desde: new Date("2026-09-01T03:00:00Z"),
              hasta: new Date("2026-09-30T03:00:00Z"),
            },
          },
        ],
      },
    ]);

    const res = await request(buildApp())
      .get("/api/promociones/conflictos")
      .set("Authorization", authHeader);

    expect(res.body).toEqual([]);
  });

  it("una programación en OFF tampoco aporta período", async () => {
    promocionMock.findMany.mockResolvedValue([
      {
        id: 1,
        nombre: "A",
        items: [{ productId: 10, porcentaje: 10, habilitado: true, product: { nombre: "X" } }],
        programaciones: [
          { desde: new Date("2026-09-01T03:00:00Z"), hasta: new Date("2026-09-30T03:00:00Z"), habilitada: true },
        ],
        campanias: [],
      },
      {
        id: 2,
        nombre: "B",
        items: [{ productId: 10, porcentaje: 20, habilitado: true, product: { nombre: "X" } }],
        programaciones: [
          { desde: new Date("2026-09-01T03:00:00Z"), hasta: new Date("2026-09-30T03:00:00Z"), habilitada: false },
        ],
        campanias: [],
      },
    ]);

    const res = await request(buildApp())
      .get("/api/promociones/conflictos")
      .set("Authorization", authHeader);

    expect(res.body).toEqual([]);
  });

  it("requiere auth", async () => {
    expect((await request(buildApp()).get("/api/promociones/conflictos")).status).toBe(401);
  });

  it("NO se confunde con /:id", async () => {
    promocionMock.findMany.mockResolvedValue([]);

    const res = await request(buildApp())
      .get("/api/promociones/conflictos")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(promocionMock.findUnique).not.toHaveBeenCalled();
  });
});

describe("POST /api/promociones/:id/evento", () => {
  it("es la primera ruta PÚBLICA del módulo: 201 sin Authorization", async () => {
    promocionMock.findUnique.mockResolvedValue({ id: 7 });
    eventoTraficoCreateMock.mockResolvedValue({ id: 2 });

    const res = await request(buildApp())
      .post("/api/promociones/7/evento")
      .send({ tipo: "CLICK_COMERCIAL", origen: "BANNER", destino: "PROMOCION" });

    expect(res.status).toBe(201);
  });

  // El guard de que abrir UNA ruta no abrió el módulo.
  it("GET /:id sigue exigiendo auth", async () => {
    const res = await request(buildApp()).get("/api/promociones/7");
    expect(res.status).toBe(401);
  });

  it("una promoción inexistente es 404", async () => {
    promocionMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .post("/api/promociones/7/evento")
      .send({ tipo: "IMPRESION_COMERCIAL", origen: "BANNER" });

    expect(res.status).toBe(404);
  });

  // Una promoción no tiene cartel: ningún `modalCtaTipo` puede apuntar a una.
  it("origen MODAL es 400 y no toca la base", async () => {
    const res = await request(buildApp())
      .post("/api/promociones/7/evento")
      .send({ tipo: "IMPRESION_COMERCIAL", origen: "MODAL" });

    expect(res.status).toBe(400);
    expect(promocionMock.findUnique).not.toHaveBeenCalled();
  });

  // El gemelo del de `campanias.routes.test.js`: los dos limitadores son dos
  // instancias distintas y nada obliga a que compartan el techo, así que sin
  // este test una de las dos podía quedarse en 600 sin que nada fallara.
  // 1800 = 600 cargas de página × ~3 eventos por carga.
  it("expone RateLimit-Limit=1800 en POST /:id/evento", async () => {
    promocionMock.findUnique.mockResolvedValue({ id: 7 });
    eventoTraficoCreateMock.mockResolvedValue({ id: 2 });

    const res = await request(buildApp())
      .post("/api/promociones/7/evento")
      .send({ tipo: "IMPRESION_COMERCIAL", origen: "BANNER" });

    expect(res.headers["ratelimit-limit"]).toBe("1800");
  });
});
