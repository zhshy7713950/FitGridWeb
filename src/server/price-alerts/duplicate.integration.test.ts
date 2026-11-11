import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createIsolatedTestDatabase } from "@/test/isolated-database";
import { AlertRepository } from "./repository";
import type { AlertCondition } from "./types";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("owner-scoped alert uniqueness in PostgreSQL", () => {
  const { db: prisma, setup, cleanup } = createIsolatedTestDatabase();
  const repo = new AlertRepository(prisma);
  const owners = [randomUUID(), randomUUID()];
  const instruments: string[] = [];
  const condition: AlertCondition = { kind: "price", direction: "up", targetPrice: "10" };
  beforeAll(async () => {
    await setup();
    await prisma.user.createMany({ data: owners.map((id) => ({ id, name: "Uniqueness test", username: id, email: `${id}@test.invalid` })) });
    for (let n = 0; n < 2; n++) instruments.push((await repo.saveInstrument({ code: `D${owners[0].slice(0, 8)}-${n}.US`, name: "Test product", market: "us", currency: "USD", kind: "stock", tencent: null, yahoo: "SPY", eastmoney: null })).id);
  });
  beforeEach(async () => {
    for (const owner of owners) await repo.scope(owner, async (tx) => { await tx.priceAlert.deleteMany(); await tx.priceAlertChannel.deleteMany(); });
  });
  afterAll(async () => {
    for (const owner of owners) await repo.scope(owner, async (tx) => { await tx.priceAlert.deleteMany(); await tx.priceAlertChannel.deleteMany(); });
    await prisma.marketInstrument.deleteMany({ where: { id: { in: instruments } } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } }); await cleanup();
  });
  const create = (owner = owners[0], input = condition, instrumentId = instruments[0]) => repo.create(owner, { instrumentId, condition: input, enabled: false });

  it("counts paused conditions as duplicates while isolating owners and products", async () => {
    await create();
    await expect(create(owners[0], { ...condition, targetPrice: "10.00" })).rejects.toMatchObject({ code: "ALERT_DUPLICATE" });
    await create(owners[1]); await create(owners[0], condition, instruments[1]);
    await create(owners[0], { ...condition, direction: "down" });
    expect(await repo.list(owners[0])).toHaveLength(3);
  });
  it("allows a deleted condition to be created again", async () => {
    const original = await create();
    await repo.update(owners[0], original.id, { expectedVersion: 1, deleted: true });
    expect((await create()).id).not.toBe(original.id);
    expect(await repo.list(owners[0])).toHaveLength(1);
  });
  it("serializes simultaneous duplicate creations so only one succeeds", async () => {
    const results = await Promise.allSettled([create(), create(owners[0], { ...condition, targetPrice: "10.00" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "ALERT_DUPLICATE" } });
    expect(await repo.list(owners[0])).toHaveLength(1);
  });
  it("serializes edits into the same condition and leaves the rejected rule unchanged", async () => {
    const first = await create(); const second = await create(owners[0], { ...condition, targetPrice: "11" });
    const results = await Promise.allSettled([first, second].map((rule) => repo.update(owners[0], rule.id, { expectedVersion: 1, condition: { ...condition, targetPrice: "12" } })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "ALERT_DUPLICATE" } });
    const rows = await repo.list(owners[0]);
    expect(rows.filter((row) => row.version === 2)).toHaveLength(1);
    expect(rows.filter((row) => row.version === 1)).toHaveLength(1);
  });
  it("preserves legacy duplicates through equivalent edits, enable, pause and deletion", async () => {
    const original = await create();
    const legacy = await repo.scope(owners[0], (tx) => tx.priceAlert.create({ data: { ownerId: owners[0], instrumentId: instruments[0], condition: { ...condition, targetPrice: "10.00" }, enabled: false, activeFrom: new Date() } }));
    await repo.saveChannel(owners[0], "test-cipher"); const channel = await repo.channel(owners[0]); await repo.markChannelTested(owners[0], channel!.version);
    let updated = await repo.update(owners[0], legacy.id, { expectedVersion: 1, condition });
    updated = await repo.update(owners[0], legacy.id, { expectedVersion: updated.version, enabled: true });
    updated = await repo.update(owners[0], legacy.id, { expectedVersion: updated.version, enabled: false });
    await repo.update(owners[0], legacy.id, { expectedVersion: updated.version, deleted: true });
    expect((await repo.detail(owners[0], original.id))?.version).toBe(1);
    expect(await repo.list(owners[0])).toHaveLength(1);
  });
});
