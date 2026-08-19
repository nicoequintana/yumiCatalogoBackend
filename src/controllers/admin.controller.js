import { prisma } from "../lib/prisma.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function listarErrorLogs(req, res, next) {
  try {
    const pageParsed = Math.floor(Number(req.query.page));
    const page = Number.isFinite(pageParsed) && pageParsed > 0 ? pageParsed : 1;

    const pageSizeParsed = Math.floor(Number(req.query.pageSize));
    const pageSize =
      Number.isFinite(pageSizeParsed) && pageSizeParsed > 0
        ? Math.min(pageSizeParsed, MAX_PAGE_SIZE)
        : DEFAULT_PAGE_SIZE;

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
