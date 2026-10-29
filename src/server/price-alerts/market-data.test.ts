import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessWindow, fetchJson, fetchSource, historySum, parseDaily, parseMinutes, selectSources, sourceUrl } from "./market-data";
import type { Instrument, ScanWindow, SourceResult } from "./types";

const cn: Instrument = { id: "cn", code: "600519.SH", name: "贵州茅台", market: "cn", currency: "CNY", kind: "stock", tencent: "sh600519", yahoo: null, eastmoney: "1.600519" };
const us: Instrument = { id: "us", code: "SPY.US", name: "SPY", market: "us", currency: "USD", kind: "etf", tencent: null, yahoo: "SPY", eastmoney: "107.SPY" };
const window: ScanWindow = { market: "cn", sessionDate: "2026-10-27", start: Date.parse("2026-10-27T02:40:00Z"), end: Date.parse("2026-10-27T02:50:00Z"), segmentStart: Date.parse("2026-10-27T01:30:00Z"), segmentEnd: Date.parse("2026-10-27T03:30:00Z"), runAt: 0, deadline: Infinity, kind: "intraday" };
async function fixture(name: string) { return JSON.parse(JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")).body); }
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }))); servers.length = 0; });

describe("real minute samples", () => {
  it("retains 499 completed closes and requests sufficient history for 500-day rules", () => {
    const dates = Array.from({ length: 900 }, (_, i) => new Date(Date.parse("2026-10-27T12:00:00Z") - i * 86400000)).filter((d) => ![0, 6].includes(d.getUTCDay())).slice(0, 640).reverse();
    const qfqday = dates.map((d) => [d.toISOString().slice(0, 10), "100", "100", "100", "100"]);
    const basis = parseDaily("tencent", { code: 0, data: { sh600519: { qfqday } } }, cn, "2026-10-28", "2026-10-28T02:00:00Z");
    expect(basis.closes).toHaveLength(499);
    expect(historySum(basis, 500)).toBe("49900");
    expect(sourceUrl("tencent", cn, true)).toContain(",640,qfq");
    expect(sourceUrl("eastmoney", cn, true)).toContain("lmt=600");
    expect(sourceUrl("yahoo", us, true)).toContain("range=5y");
  });

  it("filters Yahoo out-of-window and unfinished points before validating their OHLC", async () => {
    const body = await fixture("yahoo-spy");
    const d = body.chart.result[0]; const q = d.indicators.quote[0];
    d.timestamp.push(Date.parse("2026-10-26T20:00:13Z") / 1000);
    q.open.push(0); q.close.push(100); q.high.push(0); q.low.push(0);
    const closing = { ...window, market: "us" as const, sessionDate: "2026-10-26", start: Date.parse("2026-10-26T19:50:00Z"), end: Date.parse("2026-10-26T20:00:00Z"), segmentStart: Date.parse("2026-10-26T13:30:00Z"), segmentEnd: Date.parse("2026-10-26T20:00:00Z") };
    const bars = parseMinutes("yahoo", body, us, { window: closing, receivedAt: closing.end + 30000 });
    expect(bars).toHaveLength(10);
    expect(assessWindow(bars, closing, closing.end + 30000).missing).toEqual([]);
    const lastIndex = d.timestamp.indexOf(closing.end / 1000 - 60);
    q.high[lastIndex] = 0;
    expect(() => parseMinutes("yahoo", body, us, { window: closing, receivedAt: closing.end + 30000 })).toThrow(/OHLC|价格/);
    const incomplete = parseMinutes("yahoo", body, us, { window: closing, receivedAt: closing.end - 30000 });
    expect(assessWindow(incomplete, closing, closing.end - 30000).missing).toEqual(["2026-10-26T19:59:00.000Z"]);
  });
  it("does not turn a null target minute into a complete Yahoo window", async () => {
    const body = await fixture("yahoo-spy"); const d = body.chart.result[0];
    const closing = { ...window, market: "us" as const, sessionDate: "2026-10-26", start: Date.parse("2026-10-26T19:50:00Z"), end: Date.parse("2026-10-26T20:00:00Z"), segmentStart: Date.parse("2026-10-26T13:30:00Z"), segmentEnd: Date.parse("2026-10-26T20:00:00Z") };
    d.indicators.quote[0].open[d.timestamp.indexOf(Date.parse("2026-10-26T19:55:00Z") / 1000)] = null;
    expect(assessWindow(parseMinutes("yahoo", body, us, { window: closing, receivedAt: closing.end + 30000 }), closing, closing.end + 30000).missing).toEqual(["2026-10-26T19:55:00.000Z"]);
  });
  it("rejects stale daily tails but accepts a real holiday gap without guessing suspension", () => {
    const daily = (date: string) => ({ code: 0, data: { sh600519: { qfqday: [[date, "100", "100", "100", "100"]] } } });
    expect(() => parseDaily("tencent", daily("2026-10-20"), cn, "2026-10-27", "2026-10-27T02:00:00Z")).toThrow(/日线.*滞后|停牌/);
    expect(parseDaily("tencent", daily("2026-09-30"), cn, "2026-10-08", "2026-10-08T02:00:00Z").closes.at(-1)?.date).toBe("2026-09-30");
    expect(parseDaily("tencent", daily("2025-12-31"), cn, "2026-01-05", "2026-01-05T02:00:00Z").closes.at(-1)?.date).toBe("2025-12-31");
  });
  it("decodes Chinese metadata and aligns Tencent end labels to ten completed minutes", async () => {
    const data = await fixture("tencent-cn");
    const bars = parseMinutes("tencent", data, cn);
    const result = assessWindow(bars, window, window.end + 15000);
    expect(result.bars).toHaveLength(10);
    expect(result.bars[0].start).toBe(window.start);
    expect(result.missing).toEqual([]);
    expect(() => parseMinutes("tencent", { code: -1 }, cn)).toThrow();
  });
  it("parses SPY Eastmoney format and actual Yahoo data, retaining regular close but not the 16:00 singleton", async () => {
    const em = parseMinutes("eastmoney", { rc: 0, data: { market: 107, code: "SPY", klines: ["2026-10-27 03:51,765.1,765.2,765.3,765.0,100"] } }, us);
    const yahoo = parseMinutes("yahoo", await fixture("yahoo-spy"), us);
    expect(em[0]).toMatchObject({ start: Date.parse("2026-10-26T19:50:00Z"), high: "765.3", low: "765" });
    expect(yahoo.length).toBeGreaterThan(300);
    const closing = { ...window, market: "us" as const, sessionDate: "2026-10-26", start: Date.parse("2026-10-26T19:50:00Z"), end: Date.parse("2026-10-26T20:00:00Z"), segmentStart: Date.parse("2026-10-26T13:30:00Z"), segmentEnd: Date.parse("2026-10-26T20:00:00Z") };
    expect(assessWindow(yahoo, closing, closing.end + 30000).bars).toHaveLength(10);
    expect(assessWindow(yahoo, closing, closing.end + 30000).missing).toEqual([]);
    expect(() => parseMinutes("eastmoney", { rc: 0, data: { market: 106, code: "SPY", klines: [] } }, us)).toThrow(/匹配/);
  });
  it("rejects incomplete, conflicting and unfinished data instead of fabricating bars", async () => {
    const bars = parseMinutes("tencent", await fixture("tencent-cn"), cn);
    expect(assessWindow(bars, window, window.end - 1).missing).toContain("2026-10-27T02:49:00.000Z");
    expect(assessWindow(bars.filter((b) => b.start !== window.start), window, window.end).missing).toEqual(["2026-10-27T02:40:00.000Z"]);
    expect(() => assessWindow([...bars, { ...bars[0], close: "1" }], window, window.end)).toThrow(/冲突/);
  });
  it("uses only prior completed adjusted daily closes and rejects mismatched adjustment anchors", () => {
    const body = { chart: { result: [{ meta: { symbol: "SPY", currency: "USD", dataGranularity: "1d" }, timestamp: [1792762200, 1793021400, 1793107800], indicators: { quote: [{ close: [100, 102, 104] }], adjclose: [{ adjclose: [50, 51, 104] }] } }], error: null } };
    const basis = parseDaily("yahoo", body, us, "2026-10-27", "2026-10-27T14:00:00Z");
    expect(historySum(basis, 3)).toBe("101");
    expect(() => historySum(basis, 20)).toThrow(/不足/);
    expect(() => parseDaily("eastmoney", { rc: 0, data: { market: 107, code: "SPY", klines: ["2026-10-26,1,0,1,1"] } }, us, "2026-10-27", "2026-10-27T14:00:00Z")).toThrow();
  });
});

describe("HTTP and primary/fallback selection", () => {
  it("refreshes a valid same-session 249-close cache for a new 500-day rule", async () => {
    const dates = Array.from({ length: 1000 }, (_, i) => new Date(Date.parse("2026-10-26T12:00:00Z") - i * 86400000)).filter((d) => ![0, 6].includes(d.getUTCDay())).slice(0, 640).reverse();
    const qfqday = dates.map((d) => [d.toISOString().slice(0, 10), "100", "100", "100", "100"]);
    const cached = { provider: "tencent" as const, sessionDate: window.sessionDate, fetchedAt: "2026-10-27T02:00:00Z", adjustment: "qfq", closes: qfqday.slice(-249).map((r) => ({ date: r[0], close: r[2] })) };
    let dailyRequests = 0;
    const minutes = await fixture("tencent-cn");
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("fqkline")) { dailyRequests++; return Response.json({ code: 0, data: { sh600519: { qfqday } } }); }
      return Response.json(minutes);
    });
    const result = await fetchSource("tencent", cn, window, 500, cached, {});
    expect(result.error).toBeNull();
    expect(dailyRequests).toBe(1);
    expect(result.basis?.closes).toHaveLength(499);
  });

  it("invalidates stale same-session cached history and selects a fresh complete backup MA pair", async () => {
    const yahooMinutes = await fixture("yahoo-spy");
    const closing = { ...window, market: "us" as const, sessionDate: "2026-10-26", start: Date.parse("2026-10-26T19:50:00Z"), end: Date.parse("2026-10-26T20:00:00Z"), segmentStart: Date.parse("2026-10-26T13:30:00Z"), segmentEnd: Date.parse("2026-10-26T20:00:00Z") };
    let dailyRequests = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("interval=1m")) return Response.json(yahooMinutes);
      if (url.includes("interval=1d")) { dailyRequests++; return Response.json({ chart: { result: [{ meta: { symbol: "SPY", currency: "USD", dataGranularity: "1d" }, timestamp: [Date.parse("2026-10-20T13:30:00Z") / 1000], indicators: { quote: [{ close: [100] }], adjclose: [{ adjclose: [100] }] } }], error: null } }); }
      if (url.includes("klt=101")) return Response.json({ rc: 0, data: { market: 107, code: "SPY", klines: ["2026-10-23,100,100,101,99,100"] } });
      return Response.json({ rc: 0, data: { market: 107, code: "SPY", klines: Array.from({ length: 10 }, (_, n) => `2026-10-27 ${n === 9 ? "04:00" : `03:${51 + n}`},100,100,101,99,100`) } });
    });
    const cached = { provider: "yahoo" as const, sessionDate: closing.sessionDate, closes: [{ date: "2026-10-20", close: "100" }], fetchedAt: "2026-10-26T13:00:00Z", adjustment: "Yahoo adjusted close" };
    const primary = await fetchSource("yahoo", us, closing, 2, cached, {});
    const selected = await selectSources(primary, true, () => fetchSource("eastmoney", us, closing, 2, null, {}));
    expect(dailyRequests).toBe(1);
    expect(primary.error).toBeNull(); expect(primary.basis).toBeNull();
    expect(selected.price?.provider).toBe("yahoo"); expect(selected.ma?.provider).toBe("eastmoney");
    expect(selected.ma?.basis?.closes.at(-1)?.date).toBe("2026-10-23");
  });
  it("bounds timeout, rejects HTTP and invalid JSON errors using an actual local server", async () => {
    const server = createServer((req, res) => { if (req.url === "/slow") return; if (req.url === "/error") res.statusCode = 503; res.end(req.url === "/json" ? '{"ok":true}' : "bad"); });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("server");
    const url = `http://127.0.0.1:${address.port}`;
    expect(await fetchJson(`${url}/json`, { timeoutMs: 100 })).toEqual({ ok: true });
    await expect(fetchJson(`${url}/slow`, { timeoutMs: 30 })).rejects.toThrow();
    await expect(fetchJson(`${url}/error`)).rejects.toThrow(/503/);
    await expect(fetchJson(`${url}/invalid`)).rejects.toThrow(/JSON/);
  });
  it("keeps price rules on valid primary while MA rules use complete backup pair", async () => {
    const bars = assessWindow(parseMinutes("tencent", await fixture("tencent-cn"), cn), window, window.end).bars;
    const source: SourceResult = { provider: "tencent", bars, basis: null, fetchedAt: "2026-10-27T02:50:15Z", durationMs: 1, error: null };
    const backup: SourceResult = { ...source, provider: "eastmoney", basis: { provider: "eastmoney", sessionDate: "2026-10-27", closes: [{ date: "2026-10-26", close: "100" }], adjustment: "qfq", fetchedAt: source.fetchedAt } };
    const result = await selectSources(source, true, async () => backup);
    expect(result.price?.provider).toBe("tencent");
    expect(result.ma?.provider).toBe("eastmoney");
    expect((await selectSources({ ...source, error: "timeout", bars: [] }, false, async () => backup)).price?.provider).toBe("eastmoney");
  });
});

it("retains the exact missing minute in fetch results and its error", async () => {
  const body = await fixture("yahoo-spy"); const d = body.chart.result[0];
  const closing = { ...window, market: "us" as const, sessionDate: "2026-10-26", start: Date.parse("2026-10-26T19:50:00Z"), end: Date.parse("2026-10-26T20:00:00Z"), segmentStart: Date.parse("2026-10-26T13:30:00Z"), segmentEnd: Date.parse("2026-10-26T20:00:00Z") };
  d.indicators.quote[0].open[d.timestamp.indexOf(Date.parse("2026-10-26T19:59:00Z") / 1000)] = null;
  vi.stubGlobal("fetch", async () => Response.json(body));
  const result = await fetchSource("yahoo", us, closing, 0, null, {});
  expect(result).toMatchObject({ missingMinutes: ["2026-10-26T19:59:00.000Z"] });
  expect(result.error).toContain("2026-10-26T19:59:00.000Z");
});
