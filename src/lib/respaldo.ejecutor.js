/**
 * Ejecución del respaldo y la restauración: lo que sí toca Prisma y el disco.
 *
 * Separado de `respaldo.js` (puro, testeable sin nada) por el mismo criterio
 * que `plantillasEmail.js` frente a `notificacionesOrden.service.js`, y separado
 * de los scripts de CLI para que el test de integración pueda llamarlo sin
 * lanzar un proceso.
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ORDEN_RESTAURACION, nombreDeArchivo, serializarFila } from "./respaldo.js";

/** `Product` -> `product`, `ItemOrden` -> `itemOrden`: el nombre del delegate. */
const delegado = (modelo) => modelo.charAt(0).toLowerCase() + modelo.slice(1);

/** Columnas de dinero por tabla: vuelven a Decimal al insertar. */
const COLUMNAS_DECIMAL = {
  Product: ["precio", "costo", "coeficiente"],
  ItemOrden: ["precioUnitario", "costoUnitario"],
};

/**
 * Las fechas se detectan por FORMA (patrón ISO completo con Z), no por nombre
 * de columna: agregar un campo de fecha nuevo no exige tocar esto. Ningún
 * string de negocio de este modelo tiene esa forma exacta.
 */
const ISO_COMPLETO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function deserializarFila(modelo, fila) {
  const decimales = new Set(COLUMNAS_DECIMAL[modelo] ?? []);
  const salida = {};
  for (const [clave, valor] of Object.entries(fila)) {
    if (valor === null) {
      salida[clave] = null;
    } else if (decimales.has(clave)) {
      salida[clave] = valor; // Prisma acepta el string y lo vuelve Decimal.
    } else if (typeof valor === "string" && ISO_COMPLETO.test(valor)) {
      salida[clave] = new Date(valor);
    } else {
      salida[clave] = valor;
    }
  }
  return salida;
}

/**
 * Tope de parámetros por sentencia en SQL Server: 2100. Se deja margen porque
 * el número de columnas varía por tabla y un lote que lo pase falla entero.
 */
const MAX_PARAMETROS = 2000;

/** Parte las filas en lotes que no superen el tope de parámetros del motor. */
function* enLotes(filas) {
  const columnas = Object.keys(filas[0]).length;
  const porLote = Math.max(1, Math.floor(MAX_PARAMETROS / columnas));
  for (let i = 0; i < filas.length; i += porLote) {
    yield filas.slice(i, i + porLote);
  }
}

/**
 * Arma `[sql, ...valores]` para insertar un lote preservando los ids.
 *
 * POR QUÉ ES SQL CRUDO Y NO `prisma.create()`. `SET IDENTITY_INSERT` tiene
 * alcance de BATCH, no de sesión, y Prisma envuelve cada llamada en su propio
 * `sp_executesql`. Encenderlo en una llamada y insertar en la siguiente NO
 * funciona — verificado contra SQL Server 2022: el `INSERT` posterior falla con
 * `IDENTITY_INSERT is set to OFF` aunque el `SET` haya corrido sin error, y
 * falla igual con `create()` de Prisma que con un `INSERT` crudo separado. El
 * `SET`, el `INSERT` y el `SET OFF` tienen que viajar en la MISMA sentencia.
 *
 * Los ids tienen que preservarse: si Prisma los reasignara, cada clave foránea
 * del archivo apuntaría a otra fila y el backup quedaría corrupto aunque los
 * conteos cerraran.
 *
 * SOBRE INYECCIÓN: los nombres de tabla salen de `ORDEN_RESTAURACION` y los de
 * columna de las claves del propio respaldo, las dos cosas generadas por este
 * mismo código a partir del schema — nunca de entrada de un usuario. Aun así
 * los identificadores van entre corchetes, y TODOS LOS VALORES viajan como
 * parámetros enlazados (`@P1`, `@P2`…), nunca interpolados.
 */
function sentenciaDeInsercion(modelo, lote) {
  const columnas = Object.keys(lote[0]);
  const listaColumnas = columnas.map((c) => `[${c}]`).join(", ");

  const valores = [];
  const grupos = lote.map((fila) => {
    const marcadores = columnas.map((columna) => {
      valores.push(deserializarFila(modelo, fila)[columna]);
      return `@P${valores.length}`;
    });
    return `(${marcadores.join(", ")})`;
  });

  const sql = [
    `SET IDENTITY_INSERT [${modelo}] ON;`,
    `INSERT INTO [${modelo}] (${listaColumnas}) VALUES ${grupos.join(", ")};`,
    `SET IDENTITY_INSERT [${modelo}] OFF;`,
  ].join("\n");

  return [sql, ...valores];
}

/** Lee todas las tablas y escribe el JSON. Devuelve `{archivo, conteos, total}`. */
export async function respaldar({ prisma, destino, alAvanzar = () => {} }) {
  await mkdir(destino, { recursive: true });

  const datos = {};
  const conteos = {};
  for (const modelo of ORDEN_RESTAURACION) {
    const filas = await prisma[delegado(modelo)].findMany();
    datos[modelo] = filas.map(serializarFila);
    conteos[modelo] = filas.length;
    alAvanzar(modelo, filas.length);
  }

  const archivo = path.join(destino, nombreDeArchivo());
  await writeFile(
    archivo,
    JSON.stringify({ version: 1, generadoEn: new Date().toISOString(), conteos, datos }, null, 2),
    "utf8",
  );

  const total = Object.values(conteos).reduce((a, b) => a + b, 0);
  return { archivo, conteos, total };
}

/**
 * Vacía el destino y reinserta el respaldo. DESTRUCTIVO.
 *
 * TRES COSAS QUE NO SON OPCIONALES, y las tres se descubrieron probando una
 * restauración de verdad en vez de dando el respaldo por bueno:
 *
 *  1. `SET IDENTITY_INSERT <tabla> ON`. Los 15 modelos tienen
 *     `@default(autoincrement())`, o sea columnas IDENTITY, y SQL Server RECHAZA
 *     insertar un id explícito en ellas. Sin esto la restauración falla en la
 *     primera tabla — el respaldo se generaba perfecto y era papel mojado. Y los
 *     ids TIENEN que preservarse: si Prisma los reasignara, cada clave foránea
 *     del archivo apuntaría a otra fila. Un backup que restaura con ids
 *     distintos está corrupto aunque el conteo cierre.
 *
 *  2. Una tabla por vez. SQL Server solo admite IDENTITY_INSERT activo en UNA
 *     tabla por sesión; encenderlo en la segunda sin apagar la primera es un
 *     error, no una acumulación.
 *
 *  3. `DBCC CHECKIDENT ... RESEED`. Insertar con IDENTITY_INSERT NO mueve el
 *     contador de la secuencia: sin el reseed, la primera alta después de
 *     restaurar reusa un id ya ocupado y explota por PK. Es el modo de falla más
 *     traicionero de los tres, porque aparece DESPUÉS de que la restauración se
 *     declaró exitosa.
 *
 * El borrado va al revés que la inserción (hijos primero) porque las FK bloquean
 * borrar un padre con hijos vivos. Las dos secuencias salen del mismo array, así
 * que no pueden desincronizarse.
 *
 * TODO dentro de una transacción: una restauración a medias deja órdenes sin
 * líneas y nada que indique dónde se cortó. O entra todo, o no entra nada.
 */
export async function restaurar({ prisma, archivo, alAvanzar = () => {} }) {
  const respaldo = JSON.parse(await readFile(archivo, "utf8"));

  await prisma.$transaction(
    async (tx) => {
      for (const modelo of [...ORDEN_RESTAURACION].reverse()) {
        await tx[delegado(modelo)].deleteMany();
      }

      for (const modelo of ORDEN_RESTAURACION) {
        const filas = respaldo.datos[modelo] ?? [];
        if (filas.length === 0) continue;

        for (const lote of enLotes(filas)) {
          await tx.$executeRawUnsafe(...sentenciaDeInsercion(modelo, lote));
        }

        // Reseed DESPUÉS de todos los lotes, con el id más alto del archivo.
        const maximo = filas.reduce((max, f) => Math.max(max, f.id ?? 0), 0);
        await tx.$executeRawUnsafe(`DBCC CHECKIDENT ('[${modelo}]', RESEED, ${maximo})`);

        alAvanzar(modelo, filas.length);
      }
    },
    { timeout: 600_000 },
  );

  return { total: Object.values(respaldo.conteos ?? {}).reduce((a, b) => a + b, 0) };
}
