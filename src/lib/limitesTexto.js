/**
 * Largo máximo de las columnas de texto "cortas" del schema.
 *
 * En SQL Server, un `String` de Prisma SIN anotación `@db.*` explícita se
 * mapea a `NVarChar(1000)`. Aplica, entre otras, a
 * `EventoTrafico.referrer`/`userAgent`, `AuditLog.ruta`/`ip` y
 * `ErrorLog.ruta` — todas columnas que se llenan con datos que ARMA EL
 * CLIENTE (headers, URL del request). Insertar un valor más largo produce un
 * P2000 de Prisma, y en los loggers best-effort (`logEvento`/`logAudit`/
 * `logError`) eso significa perder el registro EN SILENCIO — incluida la
 * traza de auditoría de una mutación del admin.
 *
 * Vive en su propio módulo (y no repetido en cada logger) por el mismo
 * criterio que `limitesMedios.js`: un límite copiado en tres archivos es un
 * límite que en algún momento cambia en dos.
 */
export const LARGO_MAX_TEXTO = 1000;

/**
 * Recorta un texto al largo de su columna antes de insertarlo.
 *
 * `null`/`undefined` degradan a `null` (el valor válido para las columnas
 * opcionales), así los callers pueden pasar el header crudo sin `?? null`.
 * Cualquier otro no-string se convierte con `String()` antes de recortar —
 * este helper alimenta inserts best-effort y no puede lanzar.
 *
 * @param {unknown} valor
 * @param {number} [largo]
 * @returns {string|null}
 */
export function truncarTexto(valor, largo = LARGO_MAX_TEXTO) {
  if (valor === null || valor === undefined) return null;
  const texto = typeof valor === "string" ? valor : String(valor);
  return texto.length > largo ? texto.slice(0, largo) : texto;
}
