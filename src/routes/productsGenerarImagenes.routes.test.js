import { describe, expect, it, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

/**
 * `POST /products/:id/generar-imagenes` — dispara el flujo de n8n.
 *
 * Nada sale a la red: el servicio de n8n está mockeado. Lo que interesa acá es
 * la puerta de entrada — auth, límites de archivo, y qué se le pasa al
 * servicio— más el mapeo de sus tres modos de falla a códigos HTTP distintos.
 */

process.env.JWT_SECRET = "test-secret";

const productFindUniqueMock = vi.fn();
const enviarPedidoMock = vi.fn();
const estaConfiguradoMock = vi.fn(() => true);
const logAuditMock = vi.fn();

vi.mock("../lib/prisma.js", () => ({
  prisma: {
    product: { findUnique: (...args) => productFindUniqueMock(...args) },
  },
}));
vi.mock("../services/n8n.service.js", () => ({
  enviarPedidoDeImagenes: (...args) => enviarPedidoMock(...args),
  estaConfigurado: (...args) => estaConfiguradoMock(...args),
  MAX_REFERENCIAS: 4,
}));
vi.mock("../services/cloudinary.service.js", () => ({}));
vi.mock("../services/googleDrive.service.js", () => ({ eliminarArchivo: vi.fn() }));
vi.mock("../lib/logAudit.js", () => ({ logAudit: (...args) => logAuditMock(...args) }));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

const token = jwt.sign({ id: 1, email: "bot@yima.local" }, process.env.JWT_SECRET);
const imagen = Buffer.from("bytes-de-imagen");

const PRODUCTO = {
  id: 7,
  sku: "YIMA-TERMOM-8189",
  nombre: "Termo mate",
  descripcion: "Un termo",
  precio: { toString: () => "45000" },
  etiqueta: null,
  stock: 3,
  categoria: { id: 1, nombre: "Cocina" },
  vistas: 0,
  compartidos: 0,
  favoritosCount: 0,
  visibleEnCatalogo: false,
  destacado: false,
  orden: 0,
  fraseComercial: null,
  porQueLoVasAQuerer: null,
  tePasaEsto: null,
  caracteristicas: [],
  listas: [],
  especificaciones: [],
  fotos: [],
  video: null,
  createdAt: new Date("2026-08-26"),
  updatedAt: new Date("2026-08-26"),
};

describe("POST /products/:id/generar-imagenes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    estaConfiguradoMock.mockReturnValue(true);
    productFindUniqueMock.mockResolvedValue(PRODUCTO);
    enviarPedidoMock.mockResolvedValue({
      estado: "processing",
      carpeta: "productos/YIMA-TERMOM-8189",
    });
  });

  /** Atajo: toda request válida necesita al menos una referencia. */
  function pedir(app, id = 7) {
    return request(app)
      .post(`/api/products/${id}/generar-imagenes`)
      .set("Authorization", `Bearer ${token}`)
      .attach("referencias", imagen, { filename: "a.jpg", contentType: "image/jpeg" });
  }

  it("sin token responde 401", async () => {
    const res = await request(buildApp()).post("/api/products/7/generar-imagenes");
    expect(res.status).toBe(401);
    expect(enviarPedidoMock).not.toHaveBeenCalled();
  });

  it("envía el producto y las referencias al servicio", async () => {
    const res = await request(buildApp())
      .post("/api/products/7/generar-imagenes")
      .set("Authorization", `Bearer ${token}`)
      .attach("referencias", imagen, { filename: "a.jpg", contentType: "image/jpeg" })
      .attach("referencias", imagen, { filename: "b.png", contentType: "image/png" });

    expect(res.status).toBe(200);
    expect(res.body.enviado).toBe(true);
    expect(res.body.estado).toBe("processing");

    const argumento = enviarPedidoMock.mock.calls[0][0];
    expect(argumento.producto.sku).toBe("YIMA-TERMOM-8189");
    expect(argumento.producto.nombre).toBe("Termo mate");
    // El payload que sale es el descriptivo, no el completo: si acá apareciera
    // `precio` o `id`, alguien volvió a cablear `mapProducto`.
    expect(argumento.producto).not.toHaveProperty("precio");
    expect(argumento.producto).not.toHaveProperty("id");
    expect(argumento.referencias).toHaveLength(2);
  });

  it("rechaza el pedido SIN referencias con 400", async () => {
    // El flujo usa gpt-image-1 en modo `edit`: sin imagen de entrada no puede
    // trabajar y n8n responde 400. Se corta acá para no gastar el viaje.
    const res = await request(buildApp())
      .post("/api/products/7/generar-imagenes")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/al menos una imagen/i);
    expect(enviarPedidoMock).not.toHaveBeenCalled();
  });

  it("preserva el ORDEN de las referencias, que es lo que n8n usa", async () => {
    // n8n expone los binarios como data0/data1 en orden de aparición en el
    // form, no por nombre de campo: si este orden se invierte, la referencia
    // principal cambia sin que nada falle.
    await request(buildApp())
      .post("/api/products/7/generar-imagenes")
      .set("Authorization", `Bearer ${token}`)
      .attach("referencias", imagen, { filename: "primera.jpg", contentType: "image/jpeg" })
      .attach("referencias", imagen, { filename: "segunda.jpg", contentType: "image/jpeg" });

    const enviadas = enviarPedidoMock.mock.calls[0][0].referencias;
    expect(enviadas[0].originalname).toBe("primera.jpg");
    expect(enviadas[1].originalname).toBe("segunda.jpg");
  });

  it("informa already_processed sin tratarlo como error", async () => {
    enviarPedidoMock.mockResolvedValue({
      estado: "already_processed",
      carpeta: "productos/YIMA-TERMOM-8189",
    });

    const res = await pedir(buildApp());

    expect(res.status).toBe(200);
    expect(res.body.estado).toBe("already_processed");
    expect(res.body.carpeta).toBe("productos/YIMA-TERMOM-8189");
  });

  it("rechaza una quinta referencia (el tope es 4)", async () => {
    const res = await request(buildApp())
      .post("/api/products/7/generar-imagenes")
      .set("Authorization", `Bearer ${token}`)
      .attach("referencias", imagen, { filename: "a.jpg", contentType: "image/jpeg" })
      .attach("referencias", imagen, { filename: "b.jpg", contentType: "image/jpeg" })
      .attach("referencias", imagen, { filename: "c.jpg", contentType: "image/jpeg" })
      .attach("referencias", imagen, { filename: "d.jpg", contentType: "image/jpeg" })
      .attach("referencias", imagen, { filename: "e.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(400);
    expect(enviarPedidoMock).not.toHaveBeenCalled();
  });

  it("rechaza un tipo de archivo no permitido con 400, no con 500", async () => {
    const res = await request(buildApp())
      .post("/api/products/7/generar-imagenes")
      .set("Authorization", `Bearer ${token}`)
      .attach("referencias", Buffer.from("PDF"), {
        filename: "hoja.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JPEG|PNG|WEBP/i);
  });

  it("responde 404 si el producto no existe", async () => {
    productFindUniqueMock.mockResolvedValue(null);

    const res = await pedir(buildApp(), 999);

    expect(res.status).toBe(404);
    expect(enviarPedidoMock).not.toHaveBeenCalled();
  });

  it("responde 400 explicativo si falta la variable de entorno", async () => {
    estaConfiguradoMock.mockReturnValue(false);

    const res = await pedir(buildApp());

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no está configurada/i);
    expect(enviarPedidoMock).not.toHaveBeenCalled();
  });

  it("un webhook caído produce un error legible, no un 500 crudo", async () => {
    enviarPedidoMock.mockRejectedValue(new Error("n8n rechazó el pedido (HTTP 500)."));

    const res = await pedir(buildApp());

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/n8n/i);
  });

  it("un fallo reintentable responde 503, no 502", async () => {
    // 503 dice "temporal, volvé a intentar"; 502 dice "el de arriba está roto".
    // Para el caso de verificación fallida contra Cloudinary, el primero es el
    // correcto y es lo que hace que un reintento tenga sentido.
    const err = new Error("n8n no pudo verificar el estado en Cloudinary y no generó nada.");
    err.esReintentable = true;
    enviarPedidoMock.mockRejectedValue(err);

    const res = await pedir(buildApp());

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/no generó nada/i);
    // No se generó nada, así que tampoco hay nada que auditar como hecho.
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("deja rastro en AuditLog solo cuando el envío tuvo éxito", async () => {
    await pedir(buildApp());

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0][1]).toMatchObject({
      accion: "GENERAR_IMAGENES",
      entidad: "Producto",
      entidadId: 7,
    });
    // El estado entra en la traza: un `already_processed` no generó nada, y sin
    // este dato el AuditLog haría creer que sí.
    expect(logAuditMock.mock.calls[0][1].detalle).toMatchObject({ estado: "processing" });

    logAuditMock.mockClear();
    enviarPedidoMock.mockRejectedValue(new Error("falló"));

    await pedir(buildApp());

    expect(logAuditMock).not.toHaveBeenCalled();
  });
});
