/**
 * Piezas puras del respaldo de la base. Sin Prisma, sin filesystem, sin
 * `process.env`: mismo criterio que `lib/plantillasEmail.js` y `lib/jsonLd.js`
 * — lo que decide la CORRECTITUD de un backup se testea sin levantar nada.
 *
 * El script que las usa es `scripts/backup-db.js`. El procedimiento completo,
 * con sus límites, está en `docs/deploy/backups.md`.
 */

/**
 * Qué tabla depende de cuáles. Es el grafo de claves foráneas del schema, y de
 * él se DERIVA el orden de restauración — no al revés.
 *
 * AL AGREGAR UN MODELO CON RELACIÓN, sumarlo acá. El test de `respaldo.test.js`
 * verifica el orden contra este grafo, así que una tabla nueva mal ubicada
 * falla en la suite en vez de fallar durante una restauración de emergencia,
 * que es el peor momento posible para descubrirlo.
 */
export const DEPENDENCIAS = {
  Product: ["Categoria"],
  Caracteristica: ["Product"],
  ProductoLista: ["Product"],
  Especificacion: ["Product"],
  Foto: ["Product"],
  Video: ["Product"],
  EventoTrafico: ["Product"],
  Orden: ["Cliente"],
  ItemOrden: ["Orden", "Product"],
};

/**
 * Orden en que se restauran las tablas: cada una después de todas aquellas de
 * las que depende. Restaurar `ItemOrden` antes que `Orden` falla por FK, y una
 * restauración a medias es peor que ninguna — deja órdenes sin sus líneas, que
 * es exactamente el dato que no se puede reconstruir.
 *
 * Las que no tienen padres van primero, en cualquier orden entre sí.
 */
export const ORDEN_RESTAURACION = [
  // Sin dependencias.
  "Categoria",
  "Usuario",
  "Anuncio",
  "Cliente",
  "ErrorLog",
  "AuditLog",
  // Dependen de Categoria.
  "Product",
  // Dependen de Product.
  "Caracteristica",
  "ProductoLista",
  "Especificacion",
  "Foto",
  "Video",
  "EventoTrafico",
  // Dependen de Cliente.
  "Orden",
  // Dependen de Orden y Product.
  "ItemOrden",
];

/**
 * Convierte una fila de Prisma a algo que `JSON.stringify` no arruine.
 *
 * Dos conversiones y las dos son obligatorias:
 *
 *  - `Decimal` de Prisma serializado tal cual sale como `{s,e,d}`, no como
 *    número. El backup guardaría basura irrecuperable justo en las columnas de
 *    plata (`precio`, `costo`, `precioUnitario`, `costoUnitario`). Se emite
 *    como STRING, mismo criterio que `mapProducto` — nunca `Number()`, que
 *    reintroduce el float que todo este proyecto evita.
 *  - `Date` sale como ISO 8601, que es lo único que se vuelve a parsear igual
 *    en cualquier zona horaria.
 *
 * `null` se preserva tal cual: en este modelo un `null` SIGNIFICA algo
 * (`costoUnitario: null` es "no se puede calcular el margen", nunca "margen 0").
 */
export function serializarFila(fila) {
  const salida = {};
  for (const [clave, valor] of Object.entries(fila)) {
    if (valor === null || valor === undefined) {
      salida[clave] = valor ?? null;
    } else if (valor instanceof Date) {
      salida[clave] = valor.toISOString();
    } else if (typeof valor === "object" && valor.constructor?.name === "Decimal") {
      salida[clave] = valor.toString();
    } else {
      salida[clave] = valor;
    }
  }
  return salida;
}

/**
 * Nombre del archivo de respaldo.
 *
 * Los `:` del ISO se reemplazan por `-`: Windows no los admite en un nombre de
 * archivo, y un backup que no se puede bajar a la máquina de quien restaura no
 * sirve de nada. El formato conserva el orden lexicográfico = cronológico, así
 * que `ls` los lista en orden y la retención puede quedarse con los últimos N
 * sin parsear ninguna fecha.
 */
export function nombreDeArchivo(fecha = new Date()) {
  const marca = fecha.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  return `yima-backup-${marca}.json`;
}

/**
 * Oculta la contraseña de un connection string para poder imprimirlo.
 *
 * POR QUÉ EXISTE. Los scripts de respaldo muestran a qué base van a escribir —
 * es la verificación que evita restaurar producción encima de desarrollo, o al
 * revés. Pero esa salida termina en los logs del contenedor, así que la
 * contraseña no puede viajar con ella.
 *
 * CUBRE DOS FORMATOS, y el primero es el que importa acá: SQL Server usa
 * `;password=...` como parámetro, NO el `user:pass@host` de PostgreSQL/MySQL.
 * Una versión anterior de este código solo contemplaba el segundo, así que
 * imprimía la credencial en claro contra la única base que este proyecto usa.
 * El segundo formato queda cubierto igual, por si alguna vez cambia el motor.
 *
 * Lo que SÍ se conserva es host, puerto y nombre de base: sin eso, el mensaje
 * dejaría de servir para lo único que existe.
 */
export function enmascararConexion(cadena) {
  if (!cadena) return "(sin DATABASE_URL)";
  return cadena
    .replace(/(\b(?:password|pwd)\s*=\s*)[^;]*/gi, "$1***")
    .replace(/:\/\/([^:/@]+):[^@]*@/, "://$1:***@");
}
