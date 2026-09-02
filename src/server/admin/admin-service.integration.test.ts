import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdminService, PrismaAdminRepository } from "@/server/admin/admin-service";
import { createPrismaClient } from "@/server/db/client";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("Prisma administrator status transition", () => {
  const prisma = createPrismaClient(databaseUrl!);
  const adminA = randomUUID();
  const adminB = randomUUID();
  const ids = [adminA, adminB];

  beforeAll(async () => {
    const existingActiveAdmins = await prisma.user.count({
      where: { role: "admin", status: "active" },
    });
    if (existingActiveAdmins !== 0) {
      throw new Error("administrator concurrency integration test requires an isolated TEST_DATABASE_URL");
    }
    await prisma.user.createMany({
      data: [
        {
          id: adminA,
          name: "Admin A",
          email: `${adminA}@test.invalid`,
          username: `admin_${adminA}`,
          role: "admin",
        },
        {
          id: adminB,
          name: "Admin B",
          email: `${adminB}@test.invalid`,
          username: `admin_${adminB}`,
          role: "admin",
        },
      ],
    });
    await prisma.session.createMany({
      data: ids.map((userId) => ({
        id: randomUUID(),
        userId,
        token: `admin-status-${userId}`,
        expiresAt: new Date("2099-01-01T00:00:00Z"),
      })),
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it("keeps one active admin and revokes only the successfully disabled admin session", async () => {
    const service = new AdminService(new PrismaAdminRepository(prisma));

    const outcomes = await Promise.allSettled([
      service.updateStatus(adminA, "disabled"),
      service.updateStatus(adminB, "disabled"),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: { status: 409, code: "LAST_ACTIVE_ADMIN" },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true, sessions: { select: { id: true } } },
    });
    expect(users.filter((user) => user.status === "active")).toHaveLength(1);
    expect(users.find((user) => user.status === "active")!.sessions).toHaveLength(1);
    expect(users.find((user) => user.status === "disabled")!.sessions).toHaveLength(0);
  });
});
