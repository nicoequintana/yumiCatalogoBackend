import { PrismaMssql } from "@prisma/adapter-mssql";
import { PrismaClient } from "../src/generated/prisma/client.ts";

/**
 * Ports the 9 Spanish mock products from frontend/src/api/seed.js into the
 * real DB via Prisma Client (design D7: reseed is CLI-only, never a UI
 * button). This is DB-only fixture data — it does NOT upload any real
 * photos/video to Drive. Photos get a placeholder image URL with
 * driveFileId: null; the two mock videos also get driveFileId: null with
 * a placeholder public URL, since seeding is for local dev/demo data, not
 * real media (real media always goes through the API's Drive upload path).
 */

const adapter = new PrismaMssql(process.env.DATABASE_URL);
const prisma = new PrismaClient({ adapter });

function placeholderFotoUrl(nombreProducto, indice) {
  const texto = encodeURIComponent(`${nombreProducto} — ${indice + 1}`);
  return `https://placehold.co/800x800/39444D/E5E5DF?text=${texto}`;
}

const productos = [
  {
    nombre: "Abridor Sommelier Élite",
    descripcion:
      "Acabado en bronce cepillado y acero mate. Un objeto de precisión pensado para el ritual de descorchar una gran añada.",
    precio: "145.00",
    etiqueta: "Exclusivo",
    caracteristicas: [
      "Cuerpo en bronce cepillado",
      "Espiral de acero quirúrgico",
      "Palanca de doble apoyo",
      "Estuche de presentación incluido",
    ],
    fotosCount: 4,
    video: "https://www.w3schools.com/html/mov_bbb.mp4",
  },
  {
    nombre: "Destapador de Vinos Eléctrico",
    descripcion:
      "Experimente la apertura de sus vinos favoritos con una elegancia sin esfuerzo. Diseñado con precisión para preservar el corcho y realzar el ritual de la degustación.",
    precio: "129.00",
    etiqueta: "Best Seller",
    caracteristicas: [
      "Extracción en 6 segundos",
      "Batería para 80 botellas por carga",
      "Motor de ultra bajo ruido (<45dB)",
      "Carga tipo USB-C magnética",
    ],
    fotosCount: 2,
    video: null,
  },
  {
    nombre: "Bruma Facial Botánica",
    descripcion:
      "Cerámica mate escultural que combina diseño atemporal con una fórmula botánica hidratante para el cuidado facial diario.",
    precio: "85.00",
    etiqueta: "Nuevo",
    caracteristicas: ["Difusor de niebla ultrafina", "Cuerpo en cerámica mate", "Fórmula botánica sin alcohol"],
    fotosCount: 3,
    video: null,
  },
  {
    nombre: "Esfera Lúdica Cuero",
    descripcion: "Artesanía cosida a mano en cuero italiano. Una pieza escultural que combina juego y objeto de diseño.",
    precio: "45.00",
    etiqueta: null,
    caracteristicas: ["Cuero italiano curtido al vegetal", "Costura a mano"],
    fotosCount: 1,
    video: null,
  },
  {
    nombre: "Humidificador Aura Facial",
    descripcion: "Purifica e hidrata su entorno con un diseño escultural que se integra a cualquier espacio de la casa.",
    precio: "210.00",
    etiqueta: "Trending",
    caracteristicas: [
      "Depósito de 500ml",
      "Modo silencioso nocturno",
      "Apagado automático por bajo nivel de agua",
      "Luz ambiental regulable",
    ],
    fotosCount: 4,
    video: "https://www.w3schools.com/html/mov_bbb.mp4",
  },
  {
    nombre: "Reloj de Escritorio Meridiano",
    descripcion: "Estructura de latón macizo y esfera de mármol Carrara. Un objeto de precisión para el escritorio contemporáneo.",
    precio: "320.00",
    etiqueta: "Exclusivo",
    caracteristicas: ["Estructura de latón macizo", "Esfera en mármol Carrara", "Movimiento de cuarzo silencioso"],
    fotosCount: 2,
    video: null,
  },
  {
    nombre: "Set de Copas Cristal Facetado",
    descripcion: "Juego de seis copas en cristal facetado soplado a mano, pensadas para realzar cada varietal en la mesa.",
    precio: "180.00",
    etiqueta: "Popular",
    caracteristicas: ["Cristal soplado a mano", "Set de 6 unidades", "Apto para lavavajillas en ciclo delicado"],
    fotosCount: 3,
    video: null,
  },
  {
    nombre: "Vela Aromática Ámbar Negro",
    descripcion: "Vela de cera de soja en contenedor de vidrio ahumado, con notas de ámbar, cedro y vetiver.",
    precio: "58.00",
    etiqueta: "Nuevo",
    caracteristicas: ["Cera de soja natural", "Tiempo de combustión: 60 horas", "Contenedor de vidrio ahumado reutilizable"],
    fotosCount: 1,
    video: null,
  },
  {
    nombre: "Bandeja Decorativa Mármol Verde",
    descripcion: "Bandeja tallada en mármol verde Guatemala con base de corcho antideslizante, ideal como pieza central.",
    precio: "96.00",
    etiqueta: "Trending",
    caracteristicas: ["Mármol verde Guatemala natural", "Base de corcho antideslizante", "Cada pieza es única por vetas naturales"],
    fotosCount: 2,
    video: null,
  },
];

async function main() {
  console.log("Sembrando productos...");

  for (const p of productos) {
    const producto = await prisma.product.create({
      data: {
        nombre: p.nombre,
        descripcion: p.descripcion,
        precio: p.precio,
        etiqueta: p.etiqueta,
        caracteristicas: { create: p.caracteristicas.map((texto) => ({ texto })) },
        fotos: {
          create: Array.from({ length: p.fotosCount }, (_, i) => ({
            url: placeholderFotoUrl(p.nombre, i),
            driveFileId: null,
            orden: i,
          })),
        },
        video: p.video ? { create: { url: p.video, driveFileId: null } } : undefined,
      },
    });
    console.log(`  ✓ ${producto.nombre} (id=${producto.id})`);
  }

  const total = await prisma.product.count();
  console.log(`Listo. ${total} productos en la base.`);
}

main()
  .catch((err) => {
    console.error("Error al sembrar:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
