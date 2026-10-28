import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/server/db/client";
import { AlertRepository } from "./repository";
import { AlertScheduler } from "./scheduler";
import { encryptKey } from "./bark";
import type { BarkPayload } from "./bark";
import type { SourceResult } from "./types";

describe.skipIf(!process.env.TEST_DATABASE_URL)("durable collection and outbox", () => {
  const prisma = createPrismaClient(process.env.TEST_DATABASE_URL!);
  const owner = randomUUID();
  let now = Date.parse("2026-10-27T01:29:00Z");
  const repo = new AlertRepository(prisma, () => now);
  const secret = "ab".repeat(32);
  let instrumentId: string;
  let fetches = 0; const notifications: BarkPayload[] = [];
  let permanentFailure = false;
  const scheduler = new AlertScheduler(repo, {
    baseUrl: "https://test.invalid/fitgrid", encryptionKey: secret, beforeRequest: async () => {},
    source: async (provider, _instrument, window): Promise<SourceResult> => {
      fetches++;
      return { provider, bars: Array.from({ length: (window.end - window.start) / 60000 }, (_, n) => ({ start: window.start + n * 60000, end: window.start + (n + 1) * 60000, open: "99", low: "98", high: "101", close: "99" })), basis: null, fetchedAt: new Date(now).toISOString(), durationMs: 1, error: null };
    },
    send: async (_key, payload) => { notifications.push(payload); return permanentFailure ? { accepted: false, permanent: true, error: "Bark 拒绝请求" } : { accepted: true, permanent: false, error: null }; },
  });
  beforeAll(async () => {
    await prisma.user.create({ data: { id: owner, name: "Scheduler", username: owner, email: `${owner}@test.invalid` } });
    instrumentId = (await repo.saveInstrument({ code: `T${owner.slice(0, 8)}.SH`, name: "Fixture", market: "cn", currency: "CNY", kind: "stock", tencent: "sh600519", eastmoney: "1.600519", yahoo: null })).id;
    await repo.saveChannel(owner, encryptKey("test-device-key", secret));
    await repo.markChannelTested(owner, 1);
  });
  afterAll(async () => {
    await repo.scope(owner, async (tx) => { await tx.priceAlert.deleteMany(); await tx.priceAlertChannel.deleteMany(); });
    if (instrumentId) await prisma.marketInstrument.delete({ where: { id: instrumentId } });
    await prisma.user.delete({ where: { id: owner } });
    await prisma.marketScan.deleteMany({ where: { id: { startsWith: "cn:2026-10-27" } } });
    await prisma.$disconnect();
  });
  it("deduplicates product requests, records each trigger and sends only one message per rule", async () => {
    await repo.create(owner, { instrumentId, condition: { kind: "price", direction: "up", targetPrice: "100" }, enabled: true });
    await repo.create(owner, { instrumentId, condition: { kind: "price", direction: "up", targetPrice: "101" }, enabled: true });
    now = Date.parse("2026-10-27T01:40:15Z");
    await scheduler.tick();
    expect(fetches).toBe(1);
    expect(notifications).toHaveLength(2);
    expect(await repo.scope(owner, (tx) => tx.priceAlertEvent.count())).toBe(20);
    expect(await repo.scope(owner, (tx) => tx.priceAlertOutbox.count({ where: { status: "accepted" } }))).toBe(2);
    expect(notifications[0].url).toMatch(/^https:\/\/test.invalid\/fitgrid\/price-alerts\//);
    expect(notifications.some((n) => n.body.includes("向上达到 100 CNY"))).toBe(true);
  });
  it("survives an ordinary restart without refetching or sending processed windows", async () => {
    await scheduler.tick();
    expect(fetches).toBe(1); expect(notifications).toHaveLength(2);
  });
  it("preserves delivery acknowledgement after terminal queue entries are pruned", async () => {
    await repo.scope(owner, (tx) => tx.priceAlertOutbox.deleteMany({ where: { status: "accepted" } }));
    const rule = (await repo.activeRules(owner))[0];
    const events = await repo.events(owner, rule.id);
    expect(events[0].delivery).toMatchObject({ status: "accepted" });
  });
  it("keeps closed-session ticks free of market requests", async () => {
    now = Date.parse("2026-10-27T04:00:00Z");
    await scheduler.tick();
    expect(fetches).toBe(1);
  });
  it("drains all expired cache and private history in bounded batches, not just one thousand a day", async () => {
    const rule = (await repo.activeRules(owner))[0];
    const oldMinute = Date.parse("2026-10-10T01:30:00Z");
    const oldHistory = Date.parse("2026-09-01T01:30:00Z");
    await prisma.marketMinute.createMany({ data: Array.from({ length: 1501 }, (_, n) => ({ instrumentId, provider: "eastmoney", start: new Date(oldMinute + n * 60000), end: new Date(oldMinute + (n + 1) * 60000), open: "100", high: "100", low: "100", close: "100", fetchedAt: new Date(oldMinute) })) });
    await repo.scope(owner, async (tx) => {
      await tx.priceAlertEvent.createMany({ data: Array.from({ length: 1501 }, (_, n) => ({ ownerId: owner, ruleId: rule.id, version: 1, minuteStart: new Date(oldHistory + n * 60000), minuteEnd: new Date(oldHistory + (n + 1) * 60000), price: "100", threshold: "100", provider: "tencent", evidence: {}, createdAt: new Date(oldHistory) })) });
      await tx.priceAlertOutbox.createMany({ data: Array.from({ length: 1501 }, (_, n) => ({ ownerId: owner, ruleId: rule.id, version: 1, channelVersion: 1, batchEnd: new Date(oldHistory + n * 600000), payload: {}, status: "accepted", expiresAt: new Date(oldHistory), createdAt: new Date(oldHistory) })) });
    });
    await prisma.marketScan.update({ where: { id: "runtime" }, data: { report: {} } });
    await scheduler.tick();
    expect(await prisma.marketMinute.count({ where: { instrumentId, start: { lt: new Date("2026-10-20T00:00:00Z") } } })).toBe(0);
    expect(await repo.scope(owner, (tx) => tx.priceAlertEvent.count({ where: { createdAt: { lt: new Date("2026-09-27T00:00:00Z") } } }))).toBe(0);
    expect(await repo.scope(owner, (tx) => tx.priceAlertOutbox.count({ where: { createdAt: { lt: new Date("2026-10-20T00:00:00Z") } } }))).toBe(0);
    expect(fetches).toBe(1);
  });
  it("retains a missed morning-tail warning after successful afternoon data", async () => {
    await repo.scope(owner, (tx) => tx.priceAlert.updateMany({ data: { cursor: new Date("2026-10-27T03:20:00Z"), armed: false, lastError: "收尾失败" } }));
    now = Date.parse("2026-10-27T05:10:15Z");
    await scheduler.tick();
    const rules = await repo.activeRules(owner);
    expect(rules.every((rule) => rule.continuityDegraded)).toBe(true);
    expect(rules.every((rule) => rule.lastError === null)).toBe(true);
  });
  it("pauses an invalid channel rather than repeatedly sending new failed notifications", async () => {
    permanentFailure = true;
    now = Date.parse("2026-10-27T05:20:15Z");
    await scheduler.tick();
    expect(await repo.activeRules(owner)).toEqual([]);
    expect((await repo.channel(owner))?.testedAt).toBeNull();
  });
});
