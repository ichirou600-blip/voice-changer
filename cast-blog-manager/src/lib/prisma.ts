import { PrismaClient } from "@prisma/client";

/**
 * PrismaClient のシングルトン。
 * Next.js 開発時のホットリロードで接続が増殖しないよう globalThis に保持する。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
