import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const comboMock = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const comboItemMock = { deleteMany: vi.fn(), createMany: vi.fn() };
const productMock = { findMany: vi.fn() };
const promocionItemMock = { findMany: vi.fn() };
const usuarioFindUniqueMock = vi.fn();
const auditCreateMock = vi.fn();
const eventoTraficoCreateMock = vi.fn();
const transactionMock = vi.fn((fn) => fn({ comboItem: comboItemMock, combo: comboMock }));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    combo: {
      findMany: (...a) => comboMock.findMany(...a),
      findUnique: (...a) => comboMock.findUnique(...a),
      findFirst: (...a) => comboMock.findFirst(...a),
      create: (...a) => comboMock.create(...a),
      update: (...a) => comboMock.update(...a),
      delete: (...a) => comboMock.delete(...a),
    },
    comboItem: {
      deleteMany: (...a) => comboItemMock.deleteMany(...a),
      createMany: (...a) => comboItemMock.createMany(...a),
    },
    product: { findMany: (...a) => productMock.findMany(...a) },
    promocionItem: { findMany: (...a) => promocionItemMock.findMany(...a) },
    usuario: { findUnique: (...a) => usuarioFindUniqueMock(...a) },
    auditLog: { create: (...a) => auditCreateMock(...a) },
    eventoTrafico: { create: (...a) => eventoTraficoCreateMock(...a) },
    $transaction: (...a) => transactionMock(...a),
  },
}));

const subirArchivoMock = vi.fn();
const eliminarArchivoMock = vi.fn();
vi.mock("../services/cloudinary.service.js", () => ({
  subirArchivo: (...args) => subirArchivoMock(...args),
  eliminarArchivo: (...args) => eliminarArchivoMock(...args),
}));

const { default: combosRouter } = await import("../routes/combos.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/combos", combosRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret", {
  expiresIn: "3650d",
});
const authHeader = `Bearer ${token}`;

function fila(extra = {}) {
  return {
    id: 1,
    nombre: "Kit Living Cálido",
    frase: "Luz suave y una mesa de roble.",
    porcentaje: 15,
    activo: false,
    vigencia: "SIEMPRE",
    heroUrl: null,
    heroCloudinaryPublicId: null,
    heroCloudinaryResourceType: null,
    vistas: 0,
    items: [
      { productId: 1, cantidad: 2, product: { id: 1, sku: "LAM-01", nombre: "Lámpara", precio: 10000, stock: 9 } },
      { productId: 2, cantidad: 1, product: { id: 2, sku: "MES-01", nombre: "Mesa", precio: 25000, stock: 4 } },
    ],
    campanias: [],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: true });
  transactionMock.mockImplementation((fn) => fn({ comboItem: comboItemMock, combo: comboMock }));
  promocionItemMock.findMany.mockResolvedValue([]);
});

describe("GET /combos/admin/combos", () => {
  it("401 sin token", async () => {
    const res = await request(buildApp()).get("/api/combos/admin/combos");
    expect(res.status).toBe(401);
  });

  it("lista los combos con sus productos", async () => {
    comboMock.findMany.mockResolvedValue([fila()]);
    const res = await request(buildApp())
      .get("/api/combos/admin/combos")
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
    expect(res.body[0].nombre).toBe("Kit Living Cálido");
    expect(res.body[0].precioCombo).toBe("38250");
  });
});

describe("POST /combos/admin/combos", () => {
  it("crea un combo válido, nace apagado", async () => {
    productMock.findMany.mockResolvedValue([
      { id: 1 },
      { id: 2 },
    ]);
    comboMock.create.mockResolvedValue(fila());

    const res = await request(buildApp())
      .post("/api/combos/admin/combos")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit Living Cálido",
        frase: "Luz suave y una mesa de roble.",
        porcentaje: 15,
        items: [{ productId: 1, cantidad: 2 }, { productId: 2, cantidad: 1 }],
      });

    expect(res.status).toBe(201);
    expect(comboMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ activo: false, nombre: "Kit Living Cálido" }),
      }),
    );
  });

  it("400 con menos de 2 unidades", async () => {
    const res = await request(buildApp())
      .post("/api/combos/admin/combos")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit",
        frase: "Frase.",
        porcentaje: 15,
        items: [{ productId: 1, cantidad: 1 }],
      });
    expect(res.status).toBe(400);
  });

  it("400 con un porcentaje fuera de rango", async () => {
    const res = await request(buildApp())
      .post("/api/combos/admin/combos")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit",
        frase: "Frase.",
        porcentaje: 51,
        items: [{ productId: 1, cantidad: 1 }, { productId: 2, cantidad: 1 }],
      });
    expect(res.status).toBe(400);
  });

  it("400 sin nombre", async () => {
    const res = await request(buildApp())
      .post("/api/combos/admin/combos")
      .set("Authorization", authHeader)
      .send({
        frase: "Frase.",
        porcentaje: 15,
        items: [{ productId: 1, cantidad: 1 }, { productId: 2, cantidad: 1 }],
      });
    expect(res.status).toBe(400);
  });

  it("400 con un productId inválido, sin llegar a Prisma", async () => {
    const res = await request(buildApp())
      .post("/api/combos/admin/combos")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit",
        frase: "Frase.",
        porcentaje: 15,
        items: [{ productId: "abc", cantidad: 1 }, { productId: 2, cantidad: 1 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Cada producto necesita un `productId` válido.");
    expect(productMock.findMany).not.toHaveBeenCalled();
  });
});

describe("PUT /combos/admin/combos/:id", () => {
  it("reemplaza la lista completa de items", async () => {
    comboMock.findUnique.mockResolvedValue(fila());
    productMock.findMany.mockResolvedValue([{ id: 1 }, { id: 3 }]);
    comboMock.update.mockResolvedValue(fila({ items: [] }));

    const res = await request(buildApp())
      .put("/api/combos/admin/combos/1")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit Living Cálido",
        frase: "Luz suave y una mesa de roble.",
        porcentaje: 20,
        items: [{ productId: 1, cantidad: 1 }, { productId: 3, cantidad: 1 }],
      });

    expect(res.status).toBe(200);
    expect(comboItemMock.deleteMany).toHaveBeenCalledWith({ where: { comboId: 1 } });
    expect(comboItemMock.createMany).toHaveBeenCalledWith({
      data: [
        { comboId: 1, productId: 1, cantidad: 1 },
        { comboId: 1, productId: 3, cantidad: 1 },
      ],
    });
    // La edición de la fila va en la MISMA transacción que el reemplazo de items.
    expect(comboMock.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, data: expect.objectContaining({ porcentaje: 20 }) }),
    );
  });

  it("400 al activar un combo sin imagen principal, sin tocar la base", async () => {
    comboMock.findUnique.mockResolvedValue(fila({ heroUrl: null }));

    const res = await request(buildApp())
      .put("/api/combos/admin/combos/1")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit Living Cálido",
        frase: "Luz suave y una mesa de roble.",
        porcentaje: 15,
        activo: true,
        items: [{ productId: 1, cantidad: 2 }, { productId: 2, cantidad: 1 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Para activar el combo primero cargá la imagen principal.");
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("activa un combo que ya tiene imagen principal", async () => {
    comboMock.findUnique.mockResolvedValue(fila({ heroUrl: "https://res.cloudinary.com/x/hero.jpg" }));
    productMock.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    comboMock.update.mockResolvedValue(fila({ activo: true, heroUrl: "https://res.cloudinary.com/x/hero.jpg" }));

    const res = await request(buildApp())
      .put("/api/combos/admin/combos/1")
      .set("Authorization", authHeader)
      .send({
        nombre: "Kit Living Cálido",
        frase: "Luz suave y una mesa de roble.",
        porcentaje: 15,
        activo: true,
        items: [{ productId: 1, cantidad: 2 }, { productId: 2, cantidad: 1 }],
      });

    expect(res.status).toBe(200);
    expect(res.body.activo).toBe(true);
  });

  it("404 si el combo no existe", async () => {
    comboMock.findUnique.mockResolvedValue(null);
    const res = await request(buildApp())
      .put("/api/combos/admin/combos/999")
      .set("Authorization", authHeader)
      .send({ nombre: "X", frase: "Y", porcentaje: 10, items: [] });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /combos/admin/combos/:id", () => {
  it("403 sin permiso de borrado", async () => {
    usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: false });
    comboMock.findUnique.mockResolvedValue(fila());
    const res = await request(buildApp())
      .delete("/api/combos/admin/combos/1")
      .set("Authorization", authHeader);
    expect(res.status).toBe(403);
  });

  it("borra el combo", async () => {
    comboMock.findUnique.mockResolvedValue(fila());
    comboMock.delete.mockResolvedValue({});
    const res = await request(buildApp())
      .delete("/api/combos/admin/combos/1")
      .set("Authorization", authHeader);
    expect(res.status).toBe(200);
  });
});

describe("PUT /combos/admin/combos/:id/hero", () => {
  it("sube el hero y borra el anterior", async () => {
    comboMock.findUnique.mockResolvedValue(fila({ heroCloudinaryPublicId: "combos/viejo" }));
    subirArchivoMock.mockResolvedValue({
      url: "https://res.cloudinary.com/x/combos/nuevo.jpg",
      cloudinaryPublicId: "combos/nuevo",
      cloudinaryResourceType: "image",
    });
    comboMock.update.mockResolvedValue(fila({ heroUrl: "https://res.cloudinary.com/x/combos/nuevo.jpg" }));

    const res = await request(buildApp())
      .put("/api/combos/admin/combos/1/hero")
      .set("Authorization", authHeader)
      .attach("hero", Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "hero.jpg");

    expect(res.status).toBe(200);
    expect(eliminarArchivoMock).toHaveBeenCalledWith("combos/viejo", "image");
  });

  it("400 sin archivo", async () => {
    const res = await request(buildApp())
      .put("/api/combos/admin/combos/1/hero")
      .set("Authorization", authHeader);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /combos/admin/combos/:id — limpia el hero remoto", () => {
  it("borra el combo y después el archivo del hero en Cloudinary", async () => {
    comboMock.findUnique.mockResolvedValue(fila({ heroCloudinaryPublicId: "campanias/hero-kit", heroCloudinaryResourceType: "image" }));
    comboMock.delete.mockResolvedValue({});

    const res = await request(buildApp())
      .delete("/api/combos/admin/combos/1")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(comboMock.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(eliminarArchivoMock).toHaveBeenCalledWith("campanias/hero-kit", "image");
  });

  it("un combo sin hero no llama a Cloudinary", async () => {
    comboMock.findUnique.mockResolvedValue(fila());
    comboMock.delete.mockResolvedValue({});

    await request(buildApp()).delete("/api/combos/admin/combos/1").set("Authorization", authHeader);

    expect(eliminarArchivoMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /combos/admin/combos/:id/hero", () => {
  it("quita el hero y borra el archivo remoto", async () => {
    comboMock.findUnique.mockResolvedValue(fila({ heroCloudinaryPublicId: "combos/viejo" }));
    comboMock.update.mockResolvedValue(fila({ heroUrl: null }));

    const res = await request(buildApp())
      .delete("/api/combos/admin/combos/1/hero")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(eliminarArchivoMock).toHaveBeenCalledWith("combos/viejo", "image");
  });
});

describe("POST /combos/admin/combos/cotizar", () => {
  const PRODUCTOS = [
    { id: 1, precio: 10000, stock: 9, visibleEnCatalogo: true },
    { id: 2, precio: 25000, stock: 4, visibleEnCatalogo: true },
  ];
  const BODY = { items: [{ productId: 1, cantidad: 2 }, { productId: 2, cantidad: 1 }], porcentaje: 15 };

  it("sin promociones: devuelve las cuentas, la disponibilidad y SIN aviso", async () => {
    productMock.findMany.mockResolvedValue(PRODUCTOS);

    const res = await request(buildApp())
      .post("/api/combos/admin/combos/cotizar")
      .set("Authorization", authHeader)
      .send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      precioSeparado: "45000",
      precioCombo: "38250",
      ahorro: "6750",
      unidades: 3,
      alcanza: 4, // min(floor(9/2), floor(4/1))
      disponible: true,
      quedanPocos: false,
      precioSueltoHoy: "45000",
      avisoMasCaro: false,
    });
  });

  it("con una promo del 20 % en los dos productos, comprar suelto sale más barato: avisoMasCaro", async () => {
    productMock.findMany.mockResolvedValue(PRODUCTOS);
    promocionItemMock.findMany.mockResolvedValue([
      { productId: 1, porcentaje: 20, promocion: { id: 7, nombre: "Hot Sale" } },
      { productId: 2, porcentaje: 20, promocion: { id: 7, nombre: "Hot Sale" } },
    ]);

    const res = await request(buildApp())
      .post("/api/combos/admin/combos/cotizar")
      .set("Authorization", authHeader)
      .send(BODY);

    expect(res.status).toBe(200);
    // 8000 x 2 + 20000 = 36000 < 38250 del combo.
    expect(res.body.precioSueltoHoy).toBe("36000");
    expect(res.body.avisoMasCaro).toBe(true);
  });

  it("un producto oculto deja la cotización con disponible: false", async () => {
    productMock.findMany.mockResolvedValue([PRODUCTOS[0], { ...PRODUCTOS[1], visibleEnCatalogo: false }]);

    const res = await request(buildApp())
      .post("/api/combos/admin/combos/cotizar")
      .set("Authorization", authHeader)
      .send(BODY);

    expect(res.body.disponible).toBe(false);
  });

  it("400 con un producto que no existe, nombrando el id", async () => {
    productMock.findMany.mockResolvedValue([{ id: 1 }]);

    const res = await request(buildApp())
      .post("/api/combos/admin/combos/cotizar")
      .set("Authorization", authHeader)
      .send({ items: [{ productId: 1, cantidad: 1 }, { productId: 99, cantidad: 1 }], porcentaje: 15 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("99");
  });

  it("401 sin token", async () => {
    const res = await request(buildApp()).post("/api/combos/admin/combos/cotizar").send(BODY);
    expect(res.status).toBe(401);
  });
});

function comboPublico(extra = {}) {
  return {
    id: 1,
    nombre: "Kit Living Cálido",
    frase: "Luz suave y una mesa de roble.",
    porcentaje: 15,
    activo: true,
    vigencia: "SIEMPRE",
    heroUrl: "https://res.cloudinary.com/x/combos/1.jpg",
    vistas: 0,
    campanias: [],
    items: [
      {
        productId: 1,
        cantidad: 2,
        product: {
          id: 1,
          nombre: "Lámpara",
          precio: 10000,
          visibleEnCatalogo: true,
          stock: 9,
          categoria: { nombre: "Iluminación" },
          fotos: [{ url: "https://res.cloudinary.com/x/lampara.jpg", cloudinaryPublicId: null }],
        },
      },
      {
        productId: 2,
        cantidad: 1,
        product: {
          id: 2,
          nombre: "Mesa",
          precio: 25000,
          visibleEnCatalogo: true,
          stock: 4,
          categoria: { nombre: "Living" },
          fotos: [{ url: "https://res.cloudinary.com/x/mesa.jpg", cloudinaryPublicId: null }],
        },
      },
    ],
    ...extra,
  };
}

function conProducto(indice, cambios) {
  const base = comboPublico();
  return base.items.map((item, i) => (i === indice ? { ...item, product: { ...item.product, ...cambios } } : item));
}

describe("GET /combos", () => {
  it("lista los vigentes con la cuenta ya resuelta y sin costo", async () => {
    comboMock.findMany.mockResolvedValue([comboPublico()]);

    const res = await request(buildApp()).get("/api/combos");

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({
      id: 1,
      ruta: "/combos/1",
      nombre: "Kit Living Cálido",
      frase: "Luz suave y una mesa de roble.",
      porcentaje: 15,
      precioSeparado: "45000",
      precioCombo: "38250",
      ahorro: "6750",
      unidades: 3,
      alcanza: 4,
      disponible: true,
      quedanPocos: false,
      heroUrl: "https://res.cloudinary.com/x/combos/1.jpg",
      items: [
        { productId: 1, nombre: "Lámpara", cantidad: 2, precioLista: "10000", foto: "https://res.cloudinary.com/x/lampara.jpg", ruta: "/producto/1-lampara", categoria: "Iluminación" },
        { productId: 2, nombre: "Mesa", cantidad: 1, precioLista: "25000", foto: "https://res.cloudinary.com/x/mesa.jpg", ruta: "/producto/2-mesa", categoria: "Living" },
      ],
    });
    expect(comboMock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ activo: true }), orderBy: { createdAt: "desc" } }),
    );
  });

  it("un combo con un producto oculto sale disponible: false, no se oculta", async () => {
    comboMock.findMany.mockResolvedValue([comboPublico({ items: conProducto(1, { visibleEnCatalogo: false }) })]);

    const res = await request(buildApp()).get("/api/combos");

    expect(res.body).toHaveLength(1);
    expect(res.body[0].disponible).toBe(false);
  });

  it("con alcanza <= 3 marca quedanPocos", async () => {
    comboMock.findMany.mockResolvedValue([comboPublico({ items: conProducto(1, { stock: 2 }) })]);

    const res = await request(buildApp()).get("/api/combos");

    expect(res.body[0]).toMatchObject({ alcanza: 2, disponible: true, quedanPocos: true });
  });
});

describe("GET /combos?ids=", () => {
  it("incluye los NO vigentes con vigente: false, sin filtrar por vigencia en la consulta", async () => {
    comboMock.findMany.mockResolvedValue([comboPublico({ activo: false })]);

    const res = await request(buildApp()).get("/api/combos?ids=1");

    expect(res.status).toBe(200);
    expect(res.body[0].vigente).toBe(false);
    expect(comboMock.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: [1] } } }));
  });

  it("un vigente trae vigente: true", async () => {
    comboMock.findMany.mockResolvedValue([comboPublico()]);

    const res = await request(buildApp()).get("/api/combos?ids=1");

    expect(res.body[0].vigente).toBe(true);
  });

  it("ids sin ningún entero válido responde [] sin consultar", async () => {
    const res = await request(buildApp()).get("/api/combos?ids=abc,-1");

    expect(res.body).toEqual([]);
    expect(comboMock.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /combos/:idSlug", () => {
  it("404 si no existe", async () => {
    comboMock.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get("/api/combos/999-inexistente");
    expect(res.status).toBe(404);
  });

  it("404 si no está vigente", async () => {
    comboMock.findUnique.mockResolvedValue(comboPublico({ activo: false }));
    const res = await request(buildApp()).get("/api/combos/1-kit-living-calido");
    expect(res.status).toBe(404);
    expect(comboMock.update).not.toHaveBeenCalled();
  });

  it("200 con disponible: false si no hay stock, sin ocultarlo", async () => {
    comboMock.findUnique.mockResolvedValue(comboPublico({ items: conProducto(0, { stock: 0 }) }));
    comboMock.update.mockResolvedValue({});

    const res = await request(buildApp()).get("/api/combos/1-kit-living-calido");

    expect(res.status).toBe(200);
    expect(res.body.disponible).toBe(false);
  });

  it("suma una vista y emite VISTA_COMBO sin token", async () => {
    comboMock.findUnique.mockResolvedValue(comboPublico());
    comboMock.update.mockResolvedValue({});
    eventoTraficoCreateMock.mockResolvedValue({});

    await request(buildApp()).get("/api/combos/1-kit-living-calido");

    expect(comboMock.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { vistas: { increment: 1 } } });
    expect(eventoTraficoCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ tipo: "VISTA_COMBO", comboId: 1 }) }),
    );
  });

  it("NO suma vista con token admin", async () => {
    comboMock.findUnique.mockResolvedValue(comboPublico());

    const res = await request(buildApp()).get("/api/combos/1-kit-living-calido").set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(comboMock.update).not.toHaveBeenCalled();
    expect(eventoTraficoCreateMock).not.toHaveBeenCalled();
  });
});

describe("GET /combos/opciones", () => {
  it("es pública y expone los límites", async () => {
    const res = await request(buildApp()).get("/api/combos/opciones");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      minUnidades: 2,
      maxUnidades: 10,
      porcentajeMin: 5,
      porcentajeMax: 50,
      largoMaxNombre: 120,
      largoMaxFrase: 140,
      vigencias: ["SIEMPRE", "CAMPANIA"],
    });
  });
});

describe("GET /combos/admin/combos — vigencia resuelta", () => {
  it("emite vigente: true para un combo activo SIEMPRE y false para uno apagado", async () => {
    comboMock.findMany.mockResolvedValue([
      fila({ id: 1, activo: true }),
      fila({ id: 2, activo: false }),
    ]);

    const res = await request(buildApp()).get("/api/combos/admin/combos").set("Authorization", authHeader);

    expect(res.body.map((c) => c.vigente)).toEqual([true, false]);
  });

  it("CAMPANIA con una campaña BORRADOR no está vigente aunque esté asociada", async () => {
    comboMock.findMany.mockResolvedValue([
      fila({
        activo: true,
        vigencia: "CAMPANIA",
        campanias: [{ campania: { id: 4, nombre: "Navidad", estado: "BORRADOR", desde: new Date("2026-01-01T03:00:00Z"), hasta: new Date("2027-01-01T03:00:00Z") } }],
      }),
    ]);

    const res = await request(buildApp()).get("/api/combos/admin/combos").set("Authorization", authHeader);

    expect(res.body[0].vigente).toBe(false);
    expect(res.body[0].campania).toEqual({ id: 4, nombre: "Navidad", estado: "BORRADOR" });
  });
});
