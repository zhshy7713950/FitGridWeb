import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 }),
  });
}

const globalForPrisma = globalThis as unknown as { fitGridPrisma?: PrismaClient };

export function getPrismaClient(): PrismaClient {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not configured");
  globalForPrisma.fitGridPrisma ??= createPrismaClient(databaseUrl);
  return globalForPrisma.fitGridPrisma;
}
