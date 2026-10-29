import { describe, expect, it, vi } from "vitest";
import { AlertScheduler, backfillWindows, canFetchWindow, hasContinuityGap, mapLimited, nextDelivery } from "./scheduler";
import type { Instrument, Provider, ScanWindow, SourceResult } from "./types";
const window: ScanWindow = { market: "cn", sessionDate: "2026-10-27", segmentStart: 0, segmentEnd: 7200000, start: 3000000, end: 3600000, runAt: 3615000, deadline: 3735000, kind: "intraday" };
describe("bounded scan recovery and delivery", () => {
  it("does not settle a failed task until every already-started worker has drained", async () => {
    let release!: () => void; let siblingStarted!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { siblingStarted = r; });
    let settled = false; let siblingDone = false;
    const task = mapLimited([0, 1, 2], 2, async (index) => {
      if (index === 0) { await started; throw new Error("database failure"); }
      if (index === 1) { siblingStarted(); await gate; siblingDone = true; }
      if (index === 2) throw new Error("must not start after failure");
    }).then(() => { settled = true; }, () => { settled = true; });
    await started; await new Promise((r) => setTimeout(r, 20));
    const beforeDrain = settled;
    release(); await task;
    expect(beforeDrain).toBe(false); expect(siblingDone).toBe(true);
  });
  it("backfills at most thirty minutes in current segment and flags a discarded gap", () => {
    const result = backfillWindows(window, 600000);
    expect(result.windows.map((w) => w.start)).toEqual([1800000, 2400000, 3000000]);
    expect(result.degraded).toBe(true);
    expect(backfillWindows(window, 3000000).windows.map((w) => w.start)).toEqual([3000000]);
  });
  it("distinguishes missed lunch and overnight tails from normal market closures", () => {
    expect(hasContinuityGap("cn", Date.parse("2026-10-27T03:20:00Z"), Date.parse("2026-10-27T05:00:00Z"))).toBe(true);
    expect(hasContinuityGap("cn", Date.parse("2026-10-27T03:30:00Z"), Date.parse("2026-10-27T05:00:00Z"))).toBe(false);
    expect(hasContinuityGap("cn", Date.parse("2026-10-27T06:50:00Z"), Date.parse("2026-10-28T01:30:00Z"))).toBe(true);
    expect(hasContinuityGap("cn", Date.parse("2026-10-27T07:00:00Z"), Date.parse("2026-10-28T01:30:00Z"))).toBe(false);
    expect(hasContinuityGap("cn", Date.parse("2026-09-30T07:00:00Z"), Date.parse("2026-10-08T01:30:00Z"))).toBe(false);
  });
  it("does not fetch outside session or beyond final cleanup deadline", () => {
    expect(canFetchWindow(window, 3615000)).toBe(true);
    expect(canFetchWindow(window, 7200001)).toBe(false);
    const final = { ...window, kind: "closing" as const, deadline: 7260000 };
    expect(canFetchWindow(final, 7230000)).toBe(true);
    expect(canFetchWindow(final, 7260000)).toBe(false);
  });
  it("schedules finite retries, respects Retry-After, and expires instead of stale sending", () => {
    expect(nextDelivery({ attempts: 1, createdAt: 1000, expiresAt: 301000 }, 2000, { accepted: false, permanent: false, error: "timeout" })).toEqual({ status: "pending", nextAttemptAt: 31000 });
    expect(nextDelivery({ attempts: 2, createdAt: 1000, expiresAt: 301000 }, 40000, { accepted: false, permanent: false, error: "rate", retryAfterSeconds: 150 })).toEqual({ status: "pending", nextAttemptAt: 190000 });
    expect(nextDelivery({ attempts: 3, createdAt: 1000, expiresAt: 301000 }, 200000, { accepted: false, permanent: false, error: "timeout" }).status).toBe("failed");
    expect(nextDelivery({ attempts: 1, createdAt: 1000, expiresAt: 301000 }, 2000, { accepted: false, permanent: false, error: "rate", retryAfterSeconds: 600 }).status).toBe("expired");
  });
});


describe("retrying incomplete closing windows", () => {
  function setup() {
    let now = Date.parse("2026-10-28T20:00:30Z");
    const end = Date.parse("2026-10-28T20:00:00Z");
    const scans = new Map<string, Record<string, unknown>>();
    const instrument: Instrument = { id: "schd", code: "SCHD.US", name: "SCHD", market: "us", currency: "USD", kind: "etf", yahoo: "SCHD", tencent: null, eastmoney: null };
    const rules = ["done", "retry"].map((id) => ({ id, instrument, condition: { kind: "ma_touch", direction: "down", days: 2 }, activeFrom: new Date(end - 600000), cursor: id === "done" ? new Date(end) : null }));
    const basis = { provider: "yahoo" as const, sessionDate: "2026-10-28", fetchedAt: new Date(now).toISOString(), adjustment: "adjusted", closes: [{ date: "2026-10-27", close: "35" }] };
    const source = vi.fn(async (provider: Provider, _product: unknown, window: ScanWindow): Promise<SourceResult> => ({ provider, bars: Array.from({ length: 10 }, (_, n) => ({ start: window.start + n * 60000, end: window.start + (n + 1) * 60000, open: "35", close: "35", high: "35", low: "35" })), basis, fetchedAt: new Date(now).toISOString(), durationMs: 1, error: null as string | null, missingMinutes: [] as string[] }));
    const commit = vi.fn(async (rule: typeof rules[number], _source: unknown, window: ScanWindow) => { rule.cursor = new Date(window.end); return 0; });
    const failures: string[] = [];
    const repository = {
      clock: () => now, activeOwners: async () => ["owner"], activeRules: async () => rules,
      basis: async () => basis, saveSource: async () => {},
      recordFailure: async (_rule: unknown, error: string) => { failures.push(error); }, commitWindow: commit,
      scope: async () => [],
      prisma: { marketScan: {
        findUnique: async ({ where }: { where: { id: string } }) => where.id === "runtime" ? { report: { cleanedDate: "2026-10-28" } } : scans.get(where.id) ?? null,
        upsert: async ({ where, create, update }: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => { scans.set(where.id, { ...(scans.get(where.id) ?? create), ...update }); },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { scans.set(where.id, { ...scans.get(where.id), ...data }); },
      } },
    };
    const scheduler = new AlertScheduler(repository as unknown as import("./repository").AlertRepository, { baseUrl: "https://test.invalid", encryptionKey: "ab".repeat(32), beforeRequest: async () => {}, source });
    return { scheduler, source, commit, failures, scans, rules, end, basis, setNow: (value: number) => { now = value; } };
  }
  it("retries a partial window at :45, skips finished rules, and stops after success", async () => {
    const f = setup();
    f.source.mockResolvedValueOnce({ provider: "yahoo", bars: [], basis: f.basis, fetchedAt: "2026-10-28T20:00:30Z", durationMs: 1, error: "分钟覆盖不完整，缺少 1 分钟", missingMinutes: ["2026-10-28T19:59:00.000Z"] });
    await f.scheduler.tick();
    expect(f.failures[0]).toContain("分钟覆盖不完整");
    const report = f.scans.get(`us:2026-10-28:${f.end}`)?.report as { instruments: { primary: { missingMinutes: string[] } }[] };
    expect(report.instruments[0].primary.missingMinutes).toEqual(["2026-10-28T19:59:00.000Z"]);
    f.setNow(f.end + 45000); await f.scheduler.tick();
    expect(f.source).toHaveBeenCalledTimes(2);
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(f.commit.mock.calls[0][0].id).toBe("retry");
    await f.scheduler.tick();
    expect(f.source).toHaveBeenCalledTimes(2);
  });
  it("does not retry partial windows after the closing deadline", async () => {
    const f = setup();
    f.source.mockResolvedValueOnce({ provider: "yahoo", bars: [], basis: f.basis, fetchedAt: "2026-10-28T20:00:30Z", durationMs: 1, error: "行情返回 HTTP 429", missingMinutes: [] });
    await f.scheduler.tick();
    f.setNow(f.end + 60000); await f.scheduler.tick();
    expect(f.source).toHaveBeenCalledTimes(1);
  });
  it("reports the daily failure instead of claiming minute coverage is missing", async () => {
    const f = setup();
    f.source.mockResolvedValueOnce({ provider: "yahoo", bars: [], basis: null, fetchedAt: "2026-10-28T20:00:30Z", durationMs: 1, error: null, dailyError: "均线日线滞后，停牌或数据延迟无法确认", missingMinutes: [] });
    await f.scheduler.tick();
    expect(f.failures[0]).toContain("均线日线滞后");
    const report = f.scans.get(`us:2026-10-28:${f.end}`)?.report as { instruments: { primary: { dailyError: string } }[] };
    expect(report.instruments[0].primary.dailyError).toContain("均线日线滞后");
  });
  it("keeps known missing minutes when fallback exhausts the closing deadline", async () => {
    const f = setup();
    f.rules[0].instrument.eastmoney = "107.SCHD";
    f.source.mockResolvedValueOnce({ provider: "yahoo", bars: [], basis: f.basis, fetchedAt: "2026-10-28T20:00:30Z", durationMs: 1, error: "分钟覆盖不完整，缺少 1 分钟", missingMinutes: ["2026-10-28T19:59:00.000Z"] });
    f.source.mockImplementationOnce(async () => {
      f.setNow(f.end + 60000);
      return { provider: "eastmoney", bars: [], basis: null, fetchedAt: "2026-10-28T20:01:00Z", durationMs: 30000, error: "行情请求失败或超时" };
    });
    await f.scheduler.tick();
    expect(f.commit).not.toHaveBeenCalled();
    expect(f.failures[0]).toContain("分钟覆盖不完整");
    const report = f.scans.get(`us:2026-10-28:${f.end}`)?.report as { instruments: { primary: { missingMinutes: string[] } }[] };
    expect(report.instruments[0].primary.missingMinutes).toEqual(["2026-10-28T19:59:00.000Z"]);
  });

});
