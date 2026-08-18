import { prisma } from "../lib/prisma.js";

const DEFAULT_PAGE_SIZE = 20;

export async function listarErrorLogs(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.max(1, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE);

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
