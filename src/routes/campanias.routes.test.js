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
const usuarioFindUniqueMock = vi.fn();
const auditCreateMock = vi.fn();
const subirArchivoMock = vi.fn();
const eliminarArchivoMock = vi.fn();

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
    usuario: { findUnique: (...args) => usuarioFindUniqueMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
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
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    ...extra,
  };
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
  campaniaMock.findMany.mockResolvedValue([]);
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

  it("no arrastra el id ni los timestamps de la original", async () => {
    campaniaMock.findUnique.mockResolvedValue(fila());
    campaniaMock.create.mockResolvedValue(fila({ id: 2 }));

    await request(buildApp()).post("/api/campanias/1/duplicar").set("Authorization", authHeader);

    const { data } = campaniaMock.create.mock.calls[0][0];
    expect(data.id).toBeUndefined();
    expect(data.createdAt).toBeUndefined();
    expect(data.updatedAt).toBeUndefined();
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
    campaniaMock.findMany.mockResolvedValue([]); // nadie más comparte el doodle viejo
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
});
