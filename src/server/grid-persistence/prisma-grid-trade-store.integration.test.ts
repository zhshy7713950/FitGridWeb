import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/server/db/client";
import { withOwnerScope } from "@/server/grid-persistence/prisma-grid-trade-store";
import type { GridTradeInput } from "@/server/grid-domain/types";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

const input: GridTradeInput = {
  productName: "Owner-only",
  productCode: "SAME-CODE",
  maxPrice: "1",
  minTradeQuantity: "100",
  gearAmplitude: "5",
  perShare: "2000",
  keepShare: 2,
  increaseAmplitude: 5,
  mediumAmplitude: 15,
  bigAmplitude: 30,
  maxAmplitude: 60,
  isShort: false,
  category: null,
  sortOrder: 0,
  algorithmVersion: "android-v2.1.0",
};

integration("Prisma owner-scoped grid store", () => {
  const prisma = createPrismaClient(databaseUrl!);
  const ownerA = randomUUID();
  const ownerB = randomUUID();

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: ownerA, name: "A", email: `${ownerA}@test.invalid`, username: `a_${ownerA}` },
        { id: ownerB, name: "B", email: `${ownerB}@test.invalid`, username: `b_${ownerB}` },
      ],
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [ownerA, ownerB] } } });
    await prisma.$disconnect();
  });

  it("allows the same product code for different owners and isolates list/read", async () => {
    const rowA = await withOwnerScope(ownerA, (store) => store.create(input), prisma);
    await withOwnerScope(ownerB, (store) => store.create(input), prisma);

    await expect(withOwnerScope(ownerB, (store) => store.findById(rowA.id), prisma)).resolves.toBeNull();
    await expect(
      withOwnerScope(ownerA, (store) => store.list({ limit: 20 }), prisma),
    ).resolves.toMatchObject({ items: [{ productCode: "SAME-CODE" }] });
  });
});
