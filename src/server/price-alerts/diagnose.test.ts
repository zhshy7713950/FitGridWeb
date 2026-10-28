import { describe, expect, it, vi } from "vitest";
import { diagnoseInstrument, DIAGNOSTIC_INSTRUMENTS, parseDiagnosticArgs, selectDiagnosticWindow } from "./diagnose";
import type { DailyBasis, Instrument, Provider, ScanWindow, SourceResult } from "./types";

const cn = DIAGNOSTIC_INSTRUMENTS[0];
const us = DIAGNOSTIC_INSTRUMENTS[3];
const now = Date.parse("2026-10-27T02:03:00Z");
function sourceResult(provider: Provider, window: ScanWindow, count = 19): SourceResult {
  const closes = Array.from({ length: count }, (_, index) => ({ date: new Date(Date.parse("2026-09-01T00:00:00Z") + index * 86400000).toISOString().slice(0, 10), close: "2.50" }));
  const basis: DailyBasis = { provider, sessionDate: window.sessionDate, closes, fetchedAt: new Date(now).toISOString(), adjustment: "前复权 qfq" };
  return { provider, bars: Array.from({ length: 10 }, (_, index) => ({ start: window.start + index * 60000, end: window.start + (index + 1) * 60000, open: "2", high: "3", low: "1", close: "2" })), basis, fetchedAt: new Date(now).toISOString(), durationMs: 12, error: null };
}

describe("manual diagnostic window", () => {
  it("chooses a segment-aligned completed ten-minute window", () => {
    const selected = selectDiagnosticWindow("cn", now);
    expect(selected.kind).toBe("intraday");
    expect(selected.window).toMatchObject({ sessionDate: "2026-10-27", start: Date.parse("2026-10-27T01:50:00Z"), end: Date.parse("2026-10-27T02:00:00Z") });
  });
  it.each(["2026-10-27T01:39:59Z", "2026-10-27T05:05:00Z"])("does not disguise an insufficient active segment with older coverage at %s", (stamp) => {
    expect(selectDiagnosticWindow("cn", Date.parse(stamp))).toMatchObject({ kind: "insufficient", window: null });
  });
  it("labels lunch coverage as historical and never spans the lunch break", () => {
    const selected = selectDiagnosticWindow("cn", Date.parse("2026-10-27T04:00:00Z"));
    expect(selected).toMatchObject({ kind: "historical", window: { start: Date.parse("2026-10-27T03:20:00Z"), end: Date.parse("2026-10-27T03:30:00Z") } });
    expect(selected.label).toContain("不能代表盘中新鲜度");
  });
  it("searches published prior trading days across a weekend and holiday", () => {
    expect(selectDiagnosticWindow("cn", Date.parse("2026-10-04T04:00:00Z"))).toMatchObject({ kind: "historical", window: { sessionDate: "2026-09-30", end: Date.parse("2026-09-30T07:00:00Z") } });
  });
  it("uses NY calendar daylight saving and the published early close", () => {
    expect(selectDiagnosticWindow("us", Date.parse("2026-11-27T19:00:00Z"))).toMatchObject({ kind: "historical", window: { start: Date.parse("2026-11-27T17:50:00Z"), end: Date.parse("2026-11-27T18:00:00Z") } });
    expect(selectDiagnosticWindow("us", Date.parse("2026-10-27T13:40:00Z"))).toMatchObject({ kind: "intraday", window: { start: Date.parse("2026-10-27T13:30:00Z"), end: Date.parse("2026-10-27T13:40:00Z") } });
  });
  it("fails closed for unsupported calendar years", () => {
    expect(selectDiagnosticWindow("cn", Date.parse("2027-01-01T02:00:00Z"))).toMatchObject({ kind: "unavailable", window: null });
  });
});

describe("real source selection boundary", () => {
  it("checks both sources with fresh same-provider daily requests and reports only aggregates", async () => {
    const fetcher = vi.fn(async (provider: Provider, _instrument: Instrument, window: ScanWindow) => sourceResult(provider, window));
    const result = await diagnoseInstrument(cn, { now, days: 20, forceFailover: false }, fetcher);
    expect(fetcher.mock.calls.map(([provider]) => provider)).toEqual(["tencent", "eastmoney"]);
    expect(fetcher.mock.calls.every((call) => call[1] === cn)).toBe(true);
    expect(fetcher).toHaveBeenNthCalledWith(1, "tencent", cn, expect.any(Object), true, null, expect.objectContaining({ timeoutMs: 5000 }));
    expect(result).toMatchObject({ symbol: "600519.SH", pass: true, dualSourcePass: true, primaryError: null });
    expect(result.providers[0]).toMatchObject({ completeMinuteCount: 10, daily: { count: 19, requiredCount: 19, historySum: "47.5", adjustment: "前复权 qfq" }, pass: true });
    expect(JSON.stringify(result)).not.toContain('"closes"');
  });
  it("forces only a simulated primary failure, then really invokes backup minute plus daily", async () => {
    const fetcher = vi.fn(async (provider: Provider, _instrument: Instrument, window: ScanWindow) => sourceResult(provider, window));
    const result = await diagnoseInstrument(us, { now: Date.parse("2026-10-27T14:00:00Z"), days: 20, forceFailover: true }, fetcher);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("eastmoney", us, expect.any(Object), true, null, expect.any(Object));
    expect(result).toMatchObject({ mode: "forced-failover", pass: true, dualSourcePass: false });
    expect(result.providers[0]).toMatchObject({ provider: "yahoo", simulatedFailure: true, pass: false });
    expect(result.providers[1]).toMatchObject({ provider: "eastmoney", simulatedFailure: false, minuteLabelTimeZone: "Asia/Shanghai", minuteLabel: "end", pass: true });
  });
  it("does not pass complete minutes with too few daily closes", async () => {
    const fetcher = vi.fn(async (provider: Provider, _instrument: Instrument, window: ScanWindow) => sourceResult(provider, window, 18));
    const result = await diagnoseInstrument(cn, { now, days: 20 }, fetcher);
    expect(result.pass).toBe(false);
    expect(result.providers.every((provider) => provider.dailyError?.includes("不足") && provider.daily.historySum === null)).toBe(true);
  });
  it("does not count duplicate minutes as complete coverage or mix another source's daily basis", async () => {
    const fetcher = vi.fn(async (provider: Provider, _instrument: Instrument, window: ScanWindow) => {
      const result = sourceResult(provider, window);
      result.bars[9] = result.bars[0];
      result.basis!.provider = provider === "tencent" ? "eastmoney" : "tencent";
      return result;
    });
    const result = await diagnoseInstrument(cn, { now, days: 20 }, fetcher);
    expect(result.pass).toBe(false);
    expect(result.providers.every((provider) => provider.completeMinuteCount === 9 && provider.dailyError?.includes("来源或日期"))).toBe(true);
  });
  it("keeps provider failures independent and never prints raw exception secrets", async () => {
    const fetcher = vi.fn(async (provider: Provider, _instrument: Instrument, window: ScanWindow) => {
      if (provider === "tencent") throw new Error("secret-key-from-env");
      return { ...sourceResult(provider, window), basis: null, dailyError: "均线日线不可用" };
    });
    const result = await diagnoseInstrument(cn, { now, days: 20 }, fetcher);
    expect(result.pass).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.providers[1].dailyError).toBe("均线日线不可用");
    expect(JSON.stringify(result)).not.toContain("secret-key-from-env");
  });
  it("does not make a network request before ten complete minutes or with unknown calendars", async () => {
    const fetcher = vi.fn();
    const result = await diagnoseInstrument(cn, { now: Date.parse("2026-10-27T01:35:00Z"), days: 20 }, fetcher);
    expect(result).toMatchObject({ pass: false, coverage: "insufficient", providers: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("accepts only fixed market selectors and MA days 2 through 250", () => {
  expect(parseDiagnosticArgs([])).toEqual({ market: "all", days: 20, forceFailover: false });
  expect(parseDiagnosticArgs(["us", "--days", "250", "--force-failover"])).toEqual({ market: "us", days: 250, forceFailover: true });
  for (const args of [["--days", "1"], ["--days", "251"], ["--days", "2.5"], ["--days"], ["eu"], ["--url", "https://example.com"]]) expect(() => parseDiagnosticArgs(args)).toThrow();
  expect(DIAGNOSTIC_INSTRUMENTS.map((instrument) => instrument.code)).toEqual(["600519.SH", "510300.SH", "159919.SZ", "AAPL.US", "SPY.US"]);
});
