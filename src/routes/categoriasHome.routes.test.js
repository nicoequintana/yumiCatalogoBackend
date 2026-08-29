import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * Cobertura de lo que el panel maneja sobre la sección "Explorá por categoría"
 * de la home: qué categorías se muestran y con qué foto.
 *
 * Vive en un archivo aparte de `categorias.routes.test.js` porque necesita una
 * harness más grande —transacciones y el servicio de Cloudinary mockeados— que
 * el CRUD de nombres no usa.
 */
const categoriaMock = {
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};
const productCountMock = vi.fn();
const productGroupByMock = vi.fn();
const auditCreateMock = vi.fn();
const txMock = vi.fn();
const subirArchivoMock = vi.fn();
const eliminarArchivoMock = vi.fn();

vi.mock("../services/cloudinary.service.js", () => ({
  subirArchivo: (...args) => subirArchivoMock(...args),
  eliminarArchivo: (...args) => eliminarArchivoMock(...args),
}));

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    categoria: {
      findMany: (...args) => categoriaMock.findMany(...args),
      findUnique: (...args) => categoriaMock.findUnique(...args),
      update: (...args) => categoriaMock.update(...args),
      delete: (...args) => categoriaMock.delete(...args),
      create: vi.fn(),
    },
    product: {
      count: (...args) => productCountMock(...args),
      groupBy: (...args) => productGroupByMock(...args),
    },
    auditLog: { create: (...args) => auditCreateMock(...args) },
    $transaction: (...args) => txMock(...args),
  },
}));

const { default: categoriasRouter } = await import("./categorias.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/categorias", categoriasRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ sub: 1, email: "admin@yima.test" }, "test-secret", { expiresIn: "7d" });
const authHeader = `Bearer ${token}`;

beforeEach(() => {
  vi.clearAllMocks();
  auditCreateMock.mockResolvedValue({ id: 1 });
  productGroupByMock.mockResolvedValue([]);
  eliminarArchivoMock.mockResolvedValue(undefined);
  // El controller usa `$transaction` con callback: el tope de destacadas
  // necesita leer y escribir bajo el mismo aislamiento.
  txMock.mockImplementation(async (arg) => arg({ categoria: categoriaMock }));
});

describe("PATCH /api/categorias/:id/home — selección para la home", () => {
  it("responde 401 sin token", async () => {
    const res = await request(buildApp())
      .patch("/api/categorias/1/home")
      .send({ destacadaEnHome: true });

    expect(res.status).toBe(401);
    expect(categoriaMock.update).not.toHaveBeenCalled();
  });

  it("rechaza marcar una cuarta categoría en vez de recortar en silencio", async () => {
    // Tope DURO. Aceptarla y que la home muestre tres al azar dejaría al admin
    // creyendo que eligió algo que no se ve — el modo de falla exacto que esta
    // feature vino a eliminar.
    categoriaMock.findUnique.mockResolvedValue({
      id: 9,
      nombre: "Cuarta",
      destacadaEnHome: false,
      ordenHome: 0,
    });
    categoriaMock.findMany.mockResolvedValue([{ ordenHome: 0 }, { ordenHome: 1 }, { ordenHome: 2 }]);

    const res = await request(buildApp())
      .patch("/api/categorias/9/home")
      .set("Authorization", authHeader)
      .send({ destacadaEnHome: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/3 categorías/);
    expect(categoriaMock.update).not.toHaveBeenCalled();
  });

  it("al marcar, manda la categoría al FINAL del orden", async () => {
    // Sin esto toda categoría recién marcada empataría en el `ordenHome: 0` que
    // trae por defecto, y el orden de la home lo decidiría el desempate en vez
    // de lo que el admin eligió.
    categoriaMock.findUnique.mockResolvedValue({
      id: 9,
      nombre: "Nueva",
      destacadaEnHome: false,
      ordenHome: 0,
    });
    categoriaMock.findMany.mockResolvedValue([{ ordenHome: 0 }, { ordenHome: 1 }]);
    categoriaMock.update.mockResolvedValue({
      id: 9,
      nombre: "Nueva",
      destacadaEnHome: true,
      ordenHome: 2,
      _count: { productos: 1 },
    });

    const res = await request(buildApp())
      .patch("/api/categorias/9/home")
      .set("Authorization", authHeader)
      .send({ destacadaEnHome: true });

    expect(res.status).toBe(200);
    expect(categoriaMock.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { destacadaEnHome: true, ordenHome: 2 } }),
    );
  });

  it("desmarcar NO valida el tope", async () => {
    categoriaMock.findUnique.mockResolvedValue({
      id: 9,
      nombre: "Sale",
      destacadaEnHome: true,
      ordenHome: 1,
    });
    categoriaMock.update.mockResolvedValue({
      id: 9,
      nombre: "Sale",
      destacadaEnHome: false,
      ordenHome: 1,
      _count: { productos: 1 },
    });

    const res = await request(buildApp())
      .patch("/api/categorias/9/home")
      .set("Authorization", authHeader)
      .send({ destacadaEnHome: false });

    expect(res.status).toBe(200);
    expect(categoriaMock.findMany).not.toHaveBeenCalled();
  });

  it("valida el tope DENTRO de una transacción serializable", async () => {
    // Dos pestañas del panel marcando a la vez leerían las mismas dos
    // destacadas y escribirían una tercera cada una, dejando cuatro. Mismo
    // criterio que el borrado del último usuario admin.
    categoriaMock.findUnique.mockResolvedValue({
      id: 9,
      nombre: "Nueva",
      destacadaEnHome: false,
      ordenHome: 0,
    });
    categoriaMock.findMany.mockResolvedValue([]);
    categoriaMock.update.mockResolvedValue({
      id: 9,
      nombre: "Nueva",
      destacadaEnHome: true,
      ordenHome: 0,
      _count: { productos: 0 },
    });

    await request(buildApp())
      .patch("/api/categorias/9/home")
      .set("Authorization", authHeader)
      .send({ destacadaEnHome: true });

    expect(txMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
  });

  it("rechaza un valor que no sea booleano", async () => {
    const res = await request(buildApp())
      .patch("/api/categorias/9/home")
      .set("Authorization", authHeader)
      .send({ destacadaEnHome: "si" });

    expect(res.status).toBe(400);
  });
});

describe("imagen de categoría", () => {
  const CATEGORIA_CON_IMAGEN = {
    id: 1,
    nombre: "Cocina",
    imagenCloudinaryPublicId: "categorias/vieja",
    imagenCloudinaryResourceType: "image",
  };

  it("PUT /:id/imagen sube a Cloudinary y borra la anterior DESPUÉS de guardar", async () => {
    // Al revés, un fallo del update dejaría la fila apuntando a un archivo ya
    // borrado: la categoría se vería con la imagen rota en la home pública.
    categoriaMock.findUnique.mockResolvedValue(CATEGORIA_CON_IMAGEN);
    subirArchivoMock.mockResolvedValue({
      cloudinaryPublicId: "categorias/nueva",
      cloudinaryResourceType: "image",
      url: "https://cdn.test/nueva.jpg",
    });
    categoriaMock.update.mockResolvedValue({
      id: 1,
      nombre: "Cocina",
      imagenUrl: "https://cdn.test/nueva.jpg",
      destacadaEnHome: false,
      ordenHome: 0,
      _count: { productos: 2 },
    });

    const res = await request(buildApp())
      .put("/api/categorias/1/imagen")
      .set("Authorization", authHeader)
      .attach("imagen", Buffer.from("bytes-jpeg"), {
        filename: "cocina.jpg",
        contentType: "image/jpeg",
      });

    expect(res.status).toBe(200);
    expect(res.body.imagenUrl).toBe("https://cdn.test/nueva.jpg");
    // Fuera de producción la carpeta va prefijada — ver el test de abajo.
    expect(subirArchivoMock).toHaveBeenCalledWith(expect.any(Buffer), "image", "test/categorias");
    expect(eliminarArchivoMock).toHaveBeenCalledWith("categorias/vieja", "image");
  });

  it("rechaza un formato no permitido con 400, no con 500", async () => {
    const res = await request(buildApp())
      .put("/api/categorias/1/imagen")
      .set("Authorization", authHeader)
      .attach("imagen", Buffer.from("GIF89a"), { filename: "x.gif", contentType: "image/gif" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JPG, PNG y WEBP/);
    expect(subirArchivoMock).not.toHaveBeenCalled();
  });

  it("sin archivo responde 400", async () => {
    categoriaMock.findUnique.mockResolvedValue({ id: 1, nombre: "Cocina" });

    const res = await request(buildApp())
      .put("/api/categorias/1/imagen")
      .set("Authorization", authHeader);

    expect(res.status).toBe(400);
    expect(subirArchivoMock).not.toHaveBeenCalled();
  });

  it("DELETE /:id/imagen limpia los tres campos y borra el archivo remoto", async () => {
    categoriaMock.findUnique.mockResolvedValue(CATEGORIA_CON_IMAGEN);
    categoriaMock.update.mockResolvedValue({
      id: 1,
      nombre: "Cocina",
      imagenUrl: null,
      destacadaEnHome: false,
      ordenHome: 0,
      _count: { productos: 2 },
    });

    const res = await request(buildApp())
      .delete("/api/categorias/1/imagen")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
    expect(categoriaMock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          imagenUrl: null,
          imagenCloudinaryPublicId: null,
          imagenCloudinaryResourceType: null,
        },
      }),
    );
    expect(eliminarArchivoMock).toHaveBeenCalledWith("categorias/vieja", "image");
  });

  it("borrar la categoría borra también su imagen de Cloudinary", async () => {
    categoriaMock.findUnique.mockResolvedValue(CATEGORIA_CON_IMAGEN);
    productCountMock.mockResolvedValue(0);
    categoriaMock.delete.mockResolvedValue({ id: 1 });

    await request(buildApp()).delete("/api/categorias/1").set("Authorization", authHeader);

    expect(eliminarArchivoMock).toHaveBeenCalledWith("categorias/vieja", "image");
  });

  it("un fallo al borrar el archivo remoto NO rompe la operación del admin", async () => {
    // Lo que queda es un huérfano en Cloudinary: molesto, inofensivo. Hacer
    // fallar la operación del admin por eso sería peor.
    categoriaMock.findUnique.mockResolvedValue(CATEGORIA_CON_IMAGEN);
    eliminarArchivoMock.mockRejectedValue(new Error("Cloudinary caído"));
    categoriaMock.update.mockResolvedValue({
      id: 1,
      nombre: "Cocina",
      imagenUrl: null,
      destacadaEnHome: false,
      ordenHome: 0,
      _count: { productos: 2 },
    });

    const res = await request(buildApp())
      .delete("/api/categorias/1/imagen")
      .set("Authorization", authHeader);

    expect(res.status).toBe(200);
  });
});

describe("carpeta de Cloudinary por ambiente", () => {
  it("produccion sube a `categorias`; cualquier otro ambiente a `test/categorias`", async () => {
    // La cuenta de Cloudinary es UNA sola para los dos ambientes, así que sin
    // esta separación una prueba desde localhost deja archivos mezclados con
    // los reales y ninguna de las dos carpetas se puede limpiar a ciegas.
    const { carpetaCategorias } = await import("../controllers/categorias.controller.js");
    const original = process.env.NODE_ENV;

    try {
      process.env.NODE_ENV = "production";
      expect(carpetaCategorias()).toBe("categorias");

      process.env.NODE_ENV = "development";
      expect(carpetaCategorias()).toBe("test/categorias");

      // Default seguro: un entorno sin `NODE_ENV` ensucia la carpeta de
      // pruebas, nunca la de producción.
      delete process.env.NODE_ENV;
      expect(carpetaCategorias()).toBe("test/categorias");
    } finally {
      process.env.NODE_ENV = original;
    }
  });
});
