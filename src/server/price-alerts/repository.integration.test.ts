import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/server/db/client";
import { AlertRepository } from "./repository";
import { PrismaAdminRepository } from "@/server/admin/admin-service";
import { PriceAlertService } from "./service";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("persistent owner-scoped alerts", () => {
  const prisma = createPrismaClient(databaseUrl!);
  const owners = [randomUUID(), randomUUID()];
  const repo = new AlertRepository(prisma);
  let instrumentId: string;
  beforeAll(async () => {
    await prisma.user.createMany({ data: owners.map((id) => ({ id, name: "Alert test", email: `${id}@test.invalid`, username: id })) });
    const instrument = await repo.saveInstrument({ code: `T${randomUUID().slice(0, 8)}.US`, name: "Test ETF", market: "us", currency: "USD", kind: "etf", yahoo: "SPY", eastmoney: "107.SPY", tencent: null });
    instrumentId = instrument.id;
  });
  afterAll(async () => {
    for (const owner of owners) await repo.scope(owner, (tx) => tx.priceAlert.deleteMany());
    if (instrumentId) await prisma.marketInstrument.deleteMany({ where: { id: instrumentId } });
    await prisma.user.deleteMany({ where: { id: { in: owners } } });
    await prisma.$disconnect();
  });
  it("FORCE RLS hides rules from another owner and unscoped reads", async () => {
    const rule = await repo.create(owners[0], { instrumentId, condition: { kind: "price", direction: "up", targetPrice: "100" }, enabled: false });
    expect(await repo.detail(owners[1], rule.id)).toBeNull();
    expect(await prisma.priceAlert.findMany()).toEqual([]);
    expect((await repo.list(owners[0])).some((r) => r.id === rule.id)).toBe(true);
  });
  it("requires tested channel to enable and rejects stale editing versions", async () => {
    const rule = await repo.create(owners[0], { instrumentId, condition: { kind: "price", direction: "up", targetPrice: "100" }, enabled: false });
    await expect(repo.update(owners[0], rule.id, { expectedVersion: 1, enabled: true })).rejects.toMatchObject({ code: "CHANNEL_NOT_READY" });
    await repo.saveChannel(owners[0], "test-cipher");
    const channel = await repo.channel(owners[0]);
    await repo.markChannelTested(owners[0], channel!.version);
    const updated = await repo.update(owners[0], rule.id, { expectedVersion: 1, enabled: true });
    expect(updated).toMatchObject({ enabled: true, version: 2, armed: true });
    await expect(repo.update(owners[0], rule.id, { expectedVersion: 1, enabled: false })).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
  });
  it("does not lose tied-time history rows between pages", async () => {
    const rule = await repo.create(owners[1], { instrumentId, condition: { kind: "price", direction: "up", targetPrice: "100" }, enabled: false });
    const timestamp = new Date("2026-10-27T01:40:15Z");
    await repo.scope(owners[1], (tx) => tx.priceAlertEvent.createMany({ data: Array.from({ length: 60 }, (_, n) => ({ ownerId: owners[1], ruleId: rule.id, version: 1, minuteStart: new Date(timestamp.getTime() - n * 60000), minuteEnd: new Date(timestamp.getTime() - (n - 1) * 60000), price: "100", threshold: "100", provider: "tencent", evidence: {}, createdAt: timestamp })) }));
    const service = new PriceAlertService(repo, { encryptionKey: "ab".repeat(32), baseUrl: "https://test.invalid", beforeRequest: async () => {} });
    const first = await service.events(owners[1], rule.id);
    expect(first.items[0]).not.toHaveProperty("ownerId");
    expect(first.items[0]).not.toHaveProperty("outboxId");
    const second = await service.events(owners[1], rule.id, first.nextCursor!);
    expect(first.items).toHaveLength(50); expect(second.items).toHaveLength(10);
    expect(new Set([...first.items, ...second.items].map((e) => e.id)).size).toBe(60);
  });
  it("atomically pauses a disabled owner's active rules", async () => {
    const admin = new PrismaAdminRepository(prisma);
    await admin.updateStatusAtomically(owners[0], "disabled");
    expect(await repo.scope(owners[0], (tx) => tx.priceAlert.count({ where: { enabled: true } }))).toBe(0);
  });
});
