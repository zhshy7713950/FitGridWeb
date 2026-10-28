import { describe, expect, it } from "vitest";
import { backfillWindows, canFetchWindow, hasContinuityGap, mapLimited, nextDelivery } from "./scheduler";
import type { ScanWindow } from "./types";
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
