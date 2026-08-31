import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const anuncioMock = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
  aggregate: vi.fn(),
};
const usuarioFindUniqueMock = vi.fn();
const auditCreateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    anuncio: {
      findMany: (...args) => anuncioMock.findMany(...args),
      findUnique: (...args) => anuncioMock.findUnique(...args),
      create: (...args) => anuncioMock.create(...args),
      update: (...args) => anuncioMock.update(...args),
      delete: (...args) => anuncioMock.delete(...args),
      count: (...args) => anuncioMock.count(...args),
      aggregate: (...args) => anuncioMock.aggregate(...args),
    },
    usuario: { findUnique: (...args) => usuarioFindUniqueMock(...args) },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    $transaction: (...args) => transactionMock(...args),
  },
}));

const { default: anunciosRouter } = await import("./anuncios.routes.js");
const { MAX_ANUNCIOS, LARGO_MAX_ANUNCIO } = await import("../controllers/anuncios.controller.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/anuncios", anunciosRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "7d",
});
const authHeader = `Bearer ${token}`;

const FILA = { id: 1, texto: "Envíos a todo el país", activo: true, orden: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0 });
  anuncioMock.findMany.mockResolvedValue([FILA]);
  anuncioMock.count.mockResolvedValue(0);
  anuncioMock.aggregate.mockResolvedValue({ _max: { orden: null } });
});

describe("GET /api/anuncios", () => {
  it("sin token devuelve SOLO los activos", async () => {
    const res = await request(buildApp()).get("/api/anuncios");

    expect(res.status).toBe(200);
    expect(anuncioMock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { activo: true } }),
    );
    expect(res.body).toEqual([{ id: 1, texto: "Envíos a todo el país", activo: true, orden: 0 }]);
  });

  it("con token devuelve también los inactivos", async () => {
    await request(buildApp()).get("/api/anuncios").set("Authorization", authHeader);

    expect(anuncioMock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: undefined }),
    );
  });

  // El modo admin sale del TOKEN, nunca de la querystring. Si `?admin=1`
  // alcanzara, cualquiera vería los anuncios desactivados — y ese parámetro
  // viaja escrito en el bundle público.
  it("`?admin=1` sin token NO destraba los inactivos", async () => {
    const res = await request(buildApp()).get("/api/anuncios?admin=1");

    expect(res.status).toBe(200);
    expect(anuncioMock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { activo: true } }),
    );
  });

  // En un endpoint público, "no pude probar quién sos" y "sos anónimo" son la
  // misma respuesta: un 401 acá convertiría una sesión vencida en una cinta rota.
  it("con token inválido degrada a anónimo en vez de cortar", async () => {
    const res = await request(buildApp())
      .get("/api/anuncios")
      .set("Authorization", "Bearer basura");

    expect(res.status).toBe(200);
    expect(anuncioMock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { activo: true } }),
    );
  });

  it("ordena por `orden` y desempata por `id`", async () => {
    await request(buildApp()).get("/api/anuncios");

    expect(anuncioMock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ orden: "asc" }, { id: "asc" }] }),
    );
  });
});

describe("POST /api/anuncios", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).post("/api/anuncios").send({ texto: "Hola" });

    expect(res.status).toBe(401);
    expect(anuncioMock.create).not.toHaveBeenCalled();
  });

  it("rechaza texto vacío", async () => {
    const res = await request(buildApp())
      .post("/api/anuncios")
      .set("Authorization", authHeader)
      .send({ texto: "   " });

    expect(res.status).toBe(400);
    expect(anuncioMock.create).not.toHaveBeenCalled();
  });

  // Sin esta validación el texto llega a la base y explota como P2000, que el
  // error handler traduce a un 400 genérico sin decir qué campo ni cuál límite.
  it("rechaza un texto más largo que la columna", async () => {
    const res = await request(buildApp())
      .post("/api/anuncios")
      .set("Authorization", authHeader)
      .send({ texto: "a".repeat(LARGO_MAX_ANUNCIO + 1) });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(String(LARGO_MAX_ANUNCIO));
    expect(anuncioMock.create).not.toHaveBeenCalled();
  });

  it("rechaza pasarse del tope de anuncios", async () => {
    anuncioMock.count.mockResolvedValue(MAX_ANUNCIOS);

    const res = await request(buildApp())
      .post("/api/anuncios")
      .set("Authorization", authHeader)
      .send({ texto: "Uno más" });

    expect(res.status).toBe(400);
    expect(anuncioMock.create).not.toHaveBeenCalled();
  });

  // `orden` arranca en 0, así que sobre tabla vacía `_max.orden` es null. Sin el
  // `?? -1`, `null + 1` daría 1 y el primer anuncio nacería en la posición 1.
  it("el primer anuncio nace en la posición 0", async () => {
    anuncioMock.create.mockResolvedValue({ ...FILA, orden: 0 });

    await request(buildApp())
      .post("/api/anuncios")
      .set("Authorization", authHeader)
      .send({ texto: "Primero" });

    expect(anuncioMock.create).toHaveBeenCalledWith({
      data: { texto: "Primero", activo: true, orden: 0 },
    });
  });

  it("los siguientes van al final de la cinta", async () => {
    anuncioMock.aggregate.mockResolvedValue({ _max: { orden: 4 } });
    anuncioMock.create.mockResolvedValue({ ...FILA, orden: 5 });

    await request(buildApp())
      .post("/api/anuncios")
      .set("Authorization", authHeader)
      .send({ texto: "Último" });

    expect(anuncioMock.create).toHaveBeenCalledWith({
      data: { texto: "Último", activo: true, orden: 5 },
    });
  });

  it("registra la auditoría", async () => {
    anuncioMock.create.mockResolvedValue(FILA);

    await request(buildApp())
      .post("/api/anuncios")
      .set("Authorization", authHeader)
      .send({ texto: "Nuevo" });

    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accion: "CREAR", entidad: "Anuncio" }),
      }),
    );
  });
});

describe("PUT /api/anuncios/:id", () => {
  beforeEach(() => {
    anuncioMock.findUnique.mockResolvedValue(FILA);
    anuncioMock.update.mockResolvedValue({ ...FILA, activo: false });
  });

  // El interruptor de la fila manda `{activo}` suelto: exigir el texto lo
  // obligaría a reenviar el contenido entero para apagar un anuncio.
  it("acepta cambiar solo `activo`, sin mandar el texto", async () => {
    const res = await request(buildApp())
      .put("/api/anuncios/1")
      .set("Authorization", authHeader)
      .send({ activo: false });

    expect(res.status).toBe(200);
    expect(anuncioMock.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { texto: undefined, activo: false },
    });
  });

  // Un body sin `activo` significa "no lo toques", no "apagalo": interpretarlo
  // como false daría de baja el anuncio en cualquier edición de texto.
  it("un body sin `activo` no lo apaga", async () => {
    await request(buildApp())
      .put("/api/anuncios/1")
      .set("Authorization", authHeader)
      .send({ texto: "Nuevo texto" });

    expect(anuncioMock.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { texto: "Nuevo texto", activo: undefined },
    });
  });

  it("rechaza un body sin nada que actualizar", async () => {
    const res = await request(buildApp())
      .put("/api/anuncios/1")
      .set("Authorization", authHeader)
      .send({});

    expect(res.status).toBe(400);
    expect(anuncioMock.update).not.toHaveBeenCalled();
  });

  it("rechaza un `activo` que no sea booleano", async () => {
    const res = await request(buildApp())
      .put("/api/anuncios/1")
      .set("Authorization", authHeader)
      .send({ activo: "si" });

    expect(res.status).toBe(400);
    expect(anuncioMock.update).not.toHaveBeenCalled();
  });

  it("responde 404 si el anuncio no existe", async () => {
    anuncioMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .put("/api/anuncios/99")
      .set("Authorization", authHeader)
      .send({ texto: "Hola" });

    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/anuncios/:id", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).delete("/api/anuncios/1");

    expect(res.status).toBe(401);
    expect(anuncioMock.delete).not.toHaveBeenCalled();
  });

  it("responde 404 si no existe, en vez de un 500 de Prisma", async () => {
    anuncioMock.findUnique.mockResolvedValue(null);

    const res = await request(buildApp())
      .delete("/api/anuncios/99")
      .set("Authorization", authHeader);

    expect(res.status).toBe(404);
    expect(anuncioMock.delete).not.toHaveBeenCalled();
  });

  it("borra y audita", async () => {
    anuncioMock.findUnique.mockResolvedValue(FILA);

    const res = await request(buildApp())
      .delete("/api/anuncios/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(anuncioMock.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ accion: "ELIMINAR", entidad: "Anuncio" }),
      }),
    );
  });
});

describe("PUT /api/anuncios/orden", () => {
  beforeEach(() => {
    transactionMock.mockResolvedValue([]);
  });

  // La razón de ser del orden de declaración en el router: con `/:id` primero,
  // Express matchea "orden" como un id, `Number("orden")` da NaN y esta ruta
  // responde 404 sin que nadie entienda por qué.
  it("no se confunde con la ruta de actualizar por id", async () => {
    anuncioMock.findMany.mockResolvedValueOnce([{ id: 2 }, { id: 1 }]).mockResolvedValueOnce([]);

    const res = await request(buildApp())
      .put("/api/anuncios/orden")
      .set("Authorization", authHeader)
      .send({ ids: [2, 1] });

    expect(res.status).toBe(200);
    expect(transactionMock).toHaveBeenCalled();
    // El discriminador es `findUnique`, no `update`: `actualizar` empieza
    // buscando el id, mientras que `reordenar` solo usa `findMany`. (`update` no
    // sirve para distinguirlas — `$transaction` recibe un array de operaciones
    // ya preparadas, así que reordenar también lo invoca.)
    expect(anuncioMock.findUnique).not.toHaveBeenCalled();
  });

  it("responde 401 sin token", async () => {
    const res = await request(buildApp()).put("/api/anuncios/orden").send({ ids: [1] });

    expect(res.status).toBe(401);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rechaza una lista vacía o mal formada", async () => {
    const app = buildApp();

    for (const body of [{}, { ids: [] }, { ids: ["a"] }, { ids: [1, 1] }]) {
      const res = await request(app).put("/api/anuncios/orden").set("Authorization", authHeader).send(body);
      expect(res.status).toBe(400);
    }
    expect(transactionMock).not.toHaveBeenCalled();
  });

  // Un panel con datos viejos (un anuncio que otro admin borró) reordenaría los
  // demás igual, dejando un orden que nadie pidió.
  it("rechaza si algún id ya no existe, sin escribir nada", async () => {
    anuncioMock.findMany.mockResolvedValue([{ id: 1 }]);

    const res = await request(buildApp())
      .put("/api/anuncios/orden")
      .set("Authorization", authHeader)
      .send({ ids: [1, 2] });

    expect(res.status).toBe(400);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  // Una secuencia aplicada a medias deja la cinta en un orden que no es ni el
  // viejo ni el nuevo.
  it("escribe la secuencia entera en una transacción", async () => {
    anuncioMock.findMany.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]).mockResolvedValueOnce([]);

    await request(buildApp())
      .put("/api/anuncios/orden")
      .set("Authorization", authHeader)
      .send({ ids: [2, 1] });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(transactionMock.mock.calls[0][0]).toHaveLength(2);
  });
});
