import { PrismaMssql } from "@prisma/adapter-mssql";
import { PrismaClient } from "../generated/prisma/client.ts";

// Prisma 7.x requires an explicit driver adapter (no more implicit
// datasource URL resolution). PrismaMssql accepts the same Prisma-style
// `sqlserver://host:port;key=value;...` connection string already used in
// DATABASE_URL (see design.md / apply-progress for the confirmed format).
const adapter = new PrismaMssql(process.env.DATABASE_URL);

export const prisma = new PrismaClient({ adapter });
