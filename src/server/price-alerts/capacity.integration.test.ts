import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@/server/db/client";
import { encryptKey } from "./bark";
import { AlertRepository } from "./repository";
import { AlertScheduler } from "./scheduler";
import type { SourceResult } from "./types";

describe.skipIf(!process.env.TEST_DATABASE_URL)("native capacity acceptance (synthetic feeds, real PostgreSQL)", () => {
  const prisma = createPrismaClient(process.env.TEST_DATABASE_URL!);
  const owner = randomUUID(); const secret = "ab".repeat(32);
  let now = Date.parse("2026-10-28T01:29:00Z");
  const repo = new AlertRepository(prisma, () => now);
  const instrumentIds: string[] = [];
  let requests = 0; let active = 0; let peak = 0; const notifications = new Set<string>();
  beforeAll(async () => {
    await prisma.user.create({ data: { id: owner, name: "Load fixture", username: owner, email: `${owner}@test.invalid` } });
    await repo.saveChannel(owner, encryptKey("load-device-fixture", secret)); await repo.markChannelTested(owner, 1);
    for (let n = 0; n < 50; n++) instrumentIds.push((await repo.saveInstrument({ code: `L${owner.slice(0, 8)}-${n}.SH`, name: `Fixture ${n}`, market: "cn", currency: "CNY", kind: "stock", tencent: "sh600519", yahoo: null, eastmoney: "1.600519" })).id);
    for (const instrumentId of instrumentIds) for (let n = 0; n < 5; n++) await repo.create(owner, { instrumentId, condition: { kind: "ma_touch", direction: "up", days: 500 }, enabled: true });
  }, 60000);
  afterAll(async () => {
    await repo.scope(owner, async (tx) => { await tx.priceAlert.deleteMany(); await tx.priceAlertChannel.deleteMany(); });
    await prisma.marketInstrument.deleteMany({ where: { id: { in: instrumentIds } } });
    await prisma.user.delete({ where: { id: owner } });
    await prisma.marketScan.deleteMany({ where: { id: { startsWith: "cn:2026-10-28" } } });
    await prisma.$disconnect();
  });
  it("shares fifty source requests across 250 rules and drains bounded delivery batches without duplicates", async () => {
    const scheduler = new AlertScheduler(repo, { baseUrl: "https://test.invalid/fitgrid", encryptionKey: secret, beforeRequest: async () => {},
      source: async (provider, _product, window, requiredDays): Promise<SourceResult> => {
        expect(requiredDays).toBe(500);
        requests++; active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10)); active--;
        return { provider, bars: Array.from({ length: 10 }, (_, n) => ({ start: window.start + n * 60000, end: window.start + (n + 1) * 60000, open: "99", close: "99", high: "110", low: "98" })), basis: { provider, sessionDate: window.sessionDate, adjustment: "qfq", fetchedAt: new Date(now).toISOString(), closes: Array.from({ length: 1000 }, (_, n) => new Date(Date.parse("2026-10-27T12:00:00Z") - n * 86400000)).filter((date) => ![0, 6].includes(date.getUTCDay())).slice(0, 499).reverse().map((date) => ({ date: date.toISOString().slice(0, 10), close: "100" })) }, fetchedAt: new Date(now).toISOString(), durationMs: 10, error: null };
      },
      send: async (_key, payload, options) => { await options?.beforeRequest?.(); notifications.add(payload.id); return { accepted: true, permanent: false, error: null }; },
    });
    now = Date.parse("2026-10-28T01:40:15Z");
    const started = performance.now();
    await scheduler.tick(); now += 15000; await scheduler.tick(); now += 15000; await scheduler.tick();
    expect(requests).toBe(50); expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4);
    expect(notifications.size).toBe(250);
    expect(await repo.scope(owner, (tx) => tx.priceAlertEvent.count())).toBe(2500);
    expect(await repo.scope(owner, (tx) => tx.priceAlertOutbox.count({ where: { status: "accepted" } }))).toBe(250);
    const rssMiB = process.memoryUsage().rss / 1048576;
    expect(rssMiB).toBeLessThan(640);
    await writeFile(path.join(tmpdir(), "fitgrid-alerts-native-load.json"), JSON.stringify({ environment: "native Vitest process, synthetic feeds, PostgreSQL 17", measuredAt: new Date().toISOString(), products: 50, rules: 250, maDays: 500, requests, peakProviderConcurrency: peak, events: 2500, notifications: notifications.size, totalMs: Math.round(performance.now() - started), rssMiB: Math.round(rssMiB) }, null, 2));
  }, 60000);
});
