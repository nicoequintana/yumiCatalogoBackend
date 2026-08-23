import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { manejadorDeErrores } from "../middlewares/errorHandler.js";

process.env.JWT_SECRET = "test-secret";

/**
 * El `fileFilter` de multer corta ANTES del controller, así que un tipo de
 * archivo no permitido nunca toca la base ni el storage. Lo que se fija acá es
 * el código de estado: sin `err.status = 400`, el error handler central lo
 * trata como error interno — el admin recibía "Error interno del servidor." en
 * vez del mensaje que le dice qué formatos sirven, y encima la subida de un GIF
 * ensuciaba `ErrorLog`.
 */

vi.mock("../lib/prisma.js", () => ({ prisma: {} }));
vi.mock("../services/googleDrive.service.js", () => ({}));
vi.mock("../services/cloudinary.service.js", () => ({}));
vi.mock("../lib/logError.js", () => ({ logError: vi.fn() }));

const { default: productsRouter } = await import("./products.routes.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/products", productsRouter);
  app.use(manejadorDeErrores);
  return app;
}

const authHeader = `Bearer ${jwt.sign({ sub: 1 }, "test-secret", { expiresIn: "7d" })}`;

describe("POST /api/products — tipos de archivo no permitidos", () => {
  it("una foto con MIME no permitido responde 400 con el mensaje útil, no 500", async () => {
    const res = await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .field("nombre", "Vela")
      .field("descripcion", "Aromática")
      .field("precio", "100")
      .attach("fotos", Buffer.from("GIF89a"), { filename: "foto.gif", contentType: "image/gif" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Tipo de imagen no permitido. Use JPEG, PNG o WEBP.");
  });

  it("un video con MIME no permitido responde 400 con el mensaje útil, no 500", async () => {
    const res = await request(buildApp())
      .post("/api/products")
      .set("Authorization", authHeader)
      .field("nombre", "Vela")
      .field("descripcion", "Aromática")
      .field("precio", "100")
      .attach("video", Buffer.from("RIFF....AVI "), { filename: "video.avi", contentType: "video/x-msvideo" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Tipo de video no permitido. Use MP4 o WEBM.");
  });
});
