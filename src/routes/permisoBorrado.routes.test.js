import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

const usuarioFindUniqueMock = vi.fn();
const productDeleteMock = vi.fn();
const productFindUniqueMock = vi.fn();
const categoriaDeleteMock = vi.fn();
const anuncioDeleteMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    usuario: { findUnique: (...args) => usuarioFindUniqueMock(...args) },
    product: {
      findUnique: (...args) => productFindUniqueMock(...args),
      delete: (...args) => productDeleteMock(...args),
      findMany: vi.fn().mockResolvedValue([]),
    },
    categoria: {
      findUnique: vi.fn().mockResolvedValue({ id: 1, nombre: "X", productos: [] }),
      delete: (...args) => categoriaDeleteMock(...args),
      count: vi.fn().mockResolvedValue(0),
    },
    anuncio: {
      findUnique: vi.fn().mockResolvedValue({ id: 1, texto: "X", activo: true, orden: 0 }),
      delete: (...args) => anuncioDeleteMock(...args),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 1 }) },
    $transaction: async (cb) => (typeof cb === "function" ? cb({}) : cb),
  },
}));
vi.mock("../services/cloudinary.service.js", () => ({
  eliminarArchivo: vi.fn().mockResolvedValue(undefined),
  eliminarCarpeta: vi.fn().mockResolvedValue(undefined),
}));

const { default: productsRouter } = await import("./products.routes.js");
const { default: categoriasRouter } = await import("./categorias.routes.js");
const { default: anunciosRouter } = await import("./anuncios.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use("/api/categorias", categoriasRouter);
  app.use("/api/anuncios", anunciosRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test", tokenVersion: 0 }, "test-secret");
const auth = `Bearer ${token}`;

/** El admin del token existe, la sesión vale, pero NO puede eliminar. */
function sinPermisoDeBorrado() {
  usuarioFindUniqueMock.mockResolvedValue({ id: 1, tokenVersion: 0, puedeEliminar: false });
}

beforeEach(() => {
  usuarioFindUniqueMock.mockReset();
  productDeleteMock.mockReset();
  categoriaDeleteMock.mockReset();
  anuncioDeleteMock.mockReset();
  productFindUniqueMock.mockReset();
  productFindUniqueMock.mockResolvedValue({
    id: 42,
    nombre: "X",
    sku: "YIMA-X-1",
    fotos: [],
    video: null,
  });
});

describe("permiso de borrado en las rutas destructivas", () => {
  const rutas = [
    ["DELETE", "/api/products/42"],
    ["DELETE", "/api/categorias/1"],
    ["DELETE", "/api/anuncios/1"],
  ];

  for (const [metodo, ruta] of rutas) {
    it(`${metodo} ${ruta} responde 403 sin permiso`, async () => {
      sinPermisoDeBorrado();

      const res = await request(buildApp())[metodo.toLowerCase()](ruta).set("Authorization", auth);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain("permiso");
    });
  }

  it("POST /api/products/eliminar-masivo responde 403 sin permiso", async () => {
    sinPermisoDeBorrado();

    const res = await request(buildApp())
      .post("/api/products/eliminar-masivo")
      .set("Authorization", auth)
      .send({ ids: [1, 2] });

    expect(res.status).toBe(403);
  });

  // LO QUE HACE ÚTIL AL 403: no alcanza con rechazar, hay que rechazar ANTES de
  // tocar nada. Si el borrado ocurriera y el error llegara después, el permiso
  // sería decorativo.
  it("no borra NADA cuando rechaza", async () => {
    sinPermisoDeBorrado();

    await request(buildApp()).delete("/api/products/42").set("Authorization", auth);
    await request(buildApp()).delete("/api/categorias/1").set("Authorization", auth);
    await request(buildApp()).delete("/api/anuncios/1").set("Authorization", auth);

    expect(productDeleteMock).not.toHaveBeenCalled();
    expect(categoriaDeleteMock).not.toHaveBeenCalled();
    expect(anuncioDeleteMock).not.toHaveBeenCalled();
  });

  // El permiso acota el BORRADO DE ENTIDADES, no toda edición. Quitar una foto
  // se deshace volviendo a subirla; si el flag la cubriera, un usuario sin
  // permiso no podría ni editar un producto y el permiso sería inusable.
  it("NO bloquea quitar una foto, que es edición de contenido", async () => {
    sinPermisoDeBorrado();

    const res = await request(buildApp())
      .delete("/api/products/42/fotos/9")
      .set("Authorization", auth);

    expect(res.status).not.toBe(403);
  });
});
