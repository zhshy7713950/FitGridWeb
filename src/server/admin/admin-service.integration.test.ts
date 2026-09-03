import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { AdminService, PrismaAdminRepository } from "@/server/admin/admin-service";
import { createPrismaClient } from "@/server/db/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
const controlDatabaseUrl = process.env.MIGRATION_DATABASE_URL ?? databaseUrl;
const integration = describe.skipIf(!databaseUrl);

function quotedIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`unsafe PostgreSQL test identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function quotedGeneratedLiteral(value: string): string {
  if (!/^[a-z0-9-]{1,128}$/.test(value)) {
    throw new Error(`unsafe PostgreSQL test literal: ${value}`);
  }
  return `'${value}'`;
}

integration("Prisma administrator status transition", () => {
  const control = createPrismaClient(controlDatabaseUrl!);
  let userIds: string[] = [];
  let serviceClients: PrismaClient[] = [];
  let failureTrigger: string | null = null;
  let failureFunction: string | null = null;

  async function seedActiveAdmins(prefix: string) {
    const ids = [randomUUID(), randomUUID()];
    const tokens = ids.map((id) => `${prefix}-session-${id}`);
    userIds = ids;
    await control.user.createMany({
      data: ids.map((id, index) => ({
        id,
        name: `${prefix} Admin ${index + 1}`,
        email: `${prefix}-${id}@test.invalid`,
        username: `${prefix}_${id}`,
        role: "admin" as const,
      })),
    });
    await control.session.createMany({
      data: ids.map((userId, index) => ({
        id: randomUUID(),
        userId,
        token: tokens[index],
        expiresAt: new Date("2099-01-01T00:00:00Z"),
      })),
    });
    return { ids, tokens };
  }

  beforeEach(async () => {
    userIds = [];
    serviceClients = [];
    failureTrigger = null;
    failureFunction = null;
    const existingActiveAdmins = await control.user.count({
      where: { role: "admin", status: "active" },
    });
    if (existingActiveAdmins !== 0) {
      throw new Error("administrator integration tests require an isolated TEST_DATABASE_URL");
    }
  });

  afterEach(async () => {
    const cleanupErrors: unknown[] = [];
    async function cleanup(operation: () => Promise<unknown>) {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    const triggerToDrop = failureTrigger;
    if (triggerToDrop) {
      await cleanup(() => control.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS ${quotedIdentifier(triggerToDrop)} ON "sessions"`,
      ));
    }
    const functionToDrop = failureFunction;
    if (functionToDrop) {
      await cleanup(() => control.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS ${quotedIdentifier(functionToDrop)}()`,
      ));
    }
    if (userIds.length) {
      await cleanup(() => control.user.deleteMany({ where: { id: { in: userIds } } }));
    }
    const disconnects = await Promise.allSettled(
      serviceClients.map((client) => client.$disconnect()),
    );
    cleanupErrors.push(
      ...disconnects
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason),
    );
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "administrator integration cleanup failed");
    }
  });

  afterAll(async () => {
    await control.$disconnect();
  });

  it("serializes mutual disable requests from two independent application connections", async () => {
    const { ids } = await seedActiveAdmins("mutual");
    const clientA = createPrismaClient(databaseUrl!);
    const clientB = createPrismaClient(databaseUrl!);
    serviceClients.push(clientA, clientB);
    const serviceA = new AdminService(new PrismaAdminRepository(clientA));
    const serviceB = new AdminService(new PrismaAdminRepository(clientB));

    const outcomes = await Promise.allSettled([
      serviceA.updateStatus(ids[0], "disabled"),
      serviceB.updateStatus(ids[1], "disabled"),
    ]);

    const successes = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      reason: { status: 409, code: "LAST_ACTIVE_ADMIN" },
    });
    const users = await control.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, sessions: { select: { id: true } } },
    });
    const active = users.filter((user) => user.status === "active");
    const disabled = users.filter((user) => user.status === "disabled");
    expect(active).toHaveLength(1);
    expect(disabled).toHaveLength(1);
    expect(active[0].sessions).toHaveLength(1);
    expect(disabled[0].sessions).toHaveLength(0);
  });

  it("rolls back the status update when session revocation fails", async () => {
    const { ids, tokens } = await seedActiveAdmins("rollback");
    const suffix = randomUUID().replaceAll("-", "");
    failureFunction = `fail_admin_session_delete_${suffix}`;
    failureTrigger = `fail_admin_session_delete_${suffix}`;
    await control.$executeRawUnsafe(`
      CREATE FUNCTION ${quotedIdentifier(failureFunction)}() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'forced administrator session deletion failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await control.$executeRawUnsafe(`
      CREATE TRIGGER ${quotedIdentifier(failureTrigger)}
      BEFORE DELETE ON "sessions"
      FOR EACH ROW WHEN (OLD."token" = ${quotedGeneratedLiteral(tokens[0])})
      EXECUTE FUNCTION ${quotedIdentifier(failureFunction)}()
    `);
    const client = createPrismaClient(databaseUrl!);
    serviceClients.push(client);
    const service = new AdminService(new PrismaAdminRepository(client));

    await expect(service.updateStatus(ids[0], "disabled")).rejects.toThrow();

    const users = await control.user.findMany({
      where: { id: { in: ids } },
      orderBy: { id: "asc" },
      select: { id: true, status: true, sessions: { select: { token: true } } },
    });
    expect(users.map((user) => user.status)).toEqual(["active", "active"]);
    expect(users.find((user) => user.id === ids[0])?.sessions).toEqual([
      { token: tokens[0] },
    ]);
  });
});
