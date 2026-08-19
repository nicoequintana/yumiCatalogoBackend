import { prisma } from "../lib/prisma.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Parsea `page`/`pageSize` de la query string con los mismos defaults y tope
 * que ya usaba `listarErrorLogs`: valores fraccionarios, no numéricos,
 * negativos o cero caen al default en vez de tirar 500, y `pageSize` se
 * clampea a MAX_PAGE_SIZE para que nadie pueda pedir la tabla entera.
 */
function parsearPaginacion(query) {
  const pageParsed = Math.floor(Number(query.page));
  const page = Number.isFinite(pageParsed) && pageParsed > 0 ? pageParsed : 1;

  const pageSizeParsed = Math.floor(Number(query.pageSize));
  const pageSize =
    Number.isFinite(pageSizeParsed) && pageSizeParsed > 0
      ? Math.min(pageSizeParsed, MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;

  return { page, pageSize };
}

export async function listarErrorLogs(req, res, next) {
  try {
    const { page, pageSize } = parsearPaginacion(req.query);

    const [total, errorLogs] = await Promise.all([
      prisma.errorLog.count(),
      prisma.errorLog.findMany({
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ data: errorLogs, page, pageSize, total });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/audit-logs — traza de auditoría paginada del panel admin
 * (quién hizo qué mutación y cuándo). Protegida por el `router.use(requireAuth)`
 * de `admin.routes.js`, igual que `listarErrorLogs`.
 *
 * Misma paginación y mismo shape de respuesta (`{ data, page, pageSize, total }`)
 * que el listado de error logs — el frontend (`AdminLogs.jsx`) consume ambas
 * pestañas con la misma lógica de paginación.
 *
 * Filtro opcional por `entidad` (Producto | Orden | Usuario | Categoria). Un
 * valor vacío se ignora en vez de filtrar por string vacío (que no traería
 * nada). Alineado con el índice `[entidad, createdAt]` del modelo.
 */
export async function listarAuditLogs(req, res, next) {
  try {
    const { page, pageSize } = parsearPaginacion(req.query);

    const where = {};
    if (typeof req.query.entidad === "string" && req.query.entidad !== "") {
      where.entidad = req.query.entidad;
    }

    const [total, auditLogs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({ data: auditLogs, page, pageSize, total });
  } catch (err) {
    next(err);
  }
}
