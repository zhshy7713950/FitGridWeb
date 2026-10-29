import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "@/generated/prisma/client";

// Scheduler collection, delivery and cleanup must never see another suite's fixtures.
export function createIsolatedTestDatabase() {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://localhost/unused";
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const isolatedUrl = new URL(databaseUrl);
  isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: isolatedUrl.toString(), max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000 }, { schema }) });
  const control = new Client({ connectionString: process.env.TEST_CONTROL_DATABASE_URL ?? databaseUrl });
  return {
    db,
    async setup() {
      await control.connect();
      await control.query(`CREATE SCHEMA "${schema}"`);
      await control.query(`SET search_path TO "${schema}"`);
      const migrations = new URL("../../prisma/migrations/", import.meta.url);
      const entries = (await readdir(migrations, { withFileTypes: true })).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) await control.query(await readFile(new URL(`${entry.name}/migration.sql`, migrations), "utf8"));
      const role = decodeURIComponent(new URL(databaseUrl).username).replaceAll('"', '""');
      await control.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
    },
    async cleanup() {
      await db.$disconnect();
      try { await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await control.end(); }
    },
  };
}
