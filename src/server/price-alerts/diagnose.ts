import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dateInZone, segments, ZONES } from "./calendar";
import { assessWindow, fetchSource, historySum } from "./market-data";
import type { Instrument, Market, Provider, ScanWindow, SourceResult } from "./types";

export const DIAGNOSTIC_INSTRUMENTS: readonly Instrument[] = [
  { id: "diagnose-600519", code: "600519.SH", name: "贵州茅台", market: "cn", currency: "CNY", kind: "stock", tencent: "sh600519", yahoo: null, eastmoney: "1.600519" },
  { id: "diagnose-510300", code: "510300.SH", name: "沪深 300 ETF", market: "cn", currency: "CNY", kind: "etf", tencent: "sh510300", yahoo: null, eastmoney: "1.510300" },
  { id: "diagnose-159919", code: "159919.SZ", name: "沪深 300 ETF 嘉实", market: "cn", currency: "CNY", kind: "etf", tencent: "sz159919", yahoo: null, eastmoney: "0.159919" },
  { id: "diagnose-AAPL", code: "AAPL.US", name: "Apple", market: "us", currency: "USD", kind: "stock", tencent: null, yahoo: "AAPL", eastmoney: "105.AAPL" },
  { id: "diagnose-SPY", code: "SPY.US", name: "SPDR S&P 500 ETF", market: "us", currency: "USD", kind: "etf", tencent: null, yahoo: "SPY", eastmoney: "107.SPY" },
];

interface DiagnosticArgs { market: Market | "all"; days: number; forceFailover: boolean }
export function parseDiagnosticArgs(args: string[]): DiagnosticArgs {
  let market: DiagnosticArgs["market"] = "all";
  let days = 20;
  let forceFailover = false;
  let selectedMarket = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--force-failover") forceFailover = true;
    else if (arg === "--days") {
      const raw = args[++index];
      if (!raw || !/^\d+$/.test(raw) || Number(raw) < 2 || Number(raw) > 500) throw new Error("--days 必须为 2–500 的整数");
      days = Number(raw);
    } else if (["cn", "us", "all"].includes(arg) && !selectedMarket) {
      market = arg as DiagnosticArgs["market"]; selectedMarket = true;
    } else throw new Error("用法：diagnose.ts [cn|us|all] [--days 2..500] [--force-failover]");
  }
  return { market, days, forceFailover };
}

interface WindowSelection {
  kind: "intraday" | "historical" | "insufficient" | "unavailable";
  label: string;
  window: ScanWindow | null;
}
const MINUTE = 60_000;
const TEN_MINUTES = 10 * MINUTE;
export function selectDiagnosticWindow(market: Market, now: number): WindowSelection {
  try {
    const today = dateInZone(now, ZONES[market]);
    const current = segments(market, today);
    const active = current.find((segment) => now >= segment.start && now < segment.end);
    function selected(sessionDate: string, segment: { start: number; end: number }, end: number, historical: boolean): WindowSelection {
      return {
        kind: historical ? "historical" : "intraday",
        label: historical ? "历史覆盖检查，不能代表盘中新鲜度" : "盘中已完成分钟覆盖检查",
        window: { market, sessionDate, segmentStart: segment.start, segmentEnd: segment.end, start: end - TEN_MINUTES, end, runAt: now, deadline: now + MINUTE, kind: end === segment.end ? "closing" : "intraday" },
      };
    }
    if (active) {
      const end = active.start + Math.floor((now - active.start) / TEN_MINUTES) * TEN_MINUTES;
      if (end === active.start) return { kind: "insufficient", label: "当前交易时段尚不足 10 个已完成分钟，请稍后重试", window: null };
      return selected(today, active, end, false);
    }
    for (let offset = 0; offset <= 22; offset++) {
      const date = new Date(Date.parse(`${today}T12:00:00Z`) - offset * 86_400_000).toISOString().slice(0, 10);
      const completed = segments(market, date).filter((segment) => segment.end <= now);
      const latest = completed.at(-1);
      if (latest) return selected(date, latest, latest.end, true);
    }
    return { kind: "unavailable", label: "最近 22 天没有可检查的已发布交易时段", window: null };
  } catch {
    return { kind: "unavailable", label: "交易日历未覆盖所需日期，无法检查", window: null };
  }
}

interface ProviderDiagnostic {
  provider: Provider;
  role: "primary" | "backup";
  simulatedFailure: boolean;
  minuteLabelTimeZone: string;
  minuteLabel: "start" | "end";
  completeMinuteCount: number;
  minuteError: string | null;
  dailyError: string | null;
  daily: { count: number; requiredCount: number; from: string | null; to: string | null; historySum: string | null; adjustment: string | null };
  fetchedAt: string | null;
  durationMs: number;
  pass: boolean;
}
interface DiagnosticResult {
  symbol: string;
  market: Market;
  days: number;
  mode: "normal" | "forced-failover";
  checkedAt: string;
  coverage: WindowSelection["kind"];
  label: string;
  window: { sessionDate: string; start: string; end: string } | null;
  primaryError: string | null;
  providers: ProviderDiagnostic[];
  pass: boolean;
  dualSourcePass: boolean;
  freshnessConfirmed: boolean;
}

function summarize(result: SourceResult, role: ProviderDiagnostic["role"], window: ScanWindow, days: number, now: number, simulatedFailure = false): ProviderDiagnostic {
  let minuteError = result.error;
  let completeMinuteCount = 0;
  try {
    const assessed = assessWindow(result.bars, window, now);
    completeMinuteCount = assessed.bars.length;
    if (assessed.missing.length && !minuteError) minuteError = `分钟覆盖不完整，缺少 ${assessed.missing.length} 分钟`;
  } catch { minuteError = "分钟覆盖校验失败"; }
  const basis = result.basis;
  const sourceDailyError = "dailyError" in result && typeof result.dailyError === "string" ? result.dailyError : null;
  let dailyError = sourceDailyError;
  let sum: string | null = null;
  if (!basis) dailyError ??= "没有可用的同来源复权日线";
  else if (basis.provider !== result.provider || basis.sessionDate !== window.sessionDate) dailyError = "日线来源或日期不匹配";
  else {
    try { sum = historySum(basis, days); }
    catch { dailyError = "均线历史数据不足"; }
  }
  return {
    provider: result.provider, role, simulatedFailure,
    minuteLabelTimeZone: result.provider === "yahoo" ? ZONES.us : ZONES.cn,
    minuteLabel: result.provider === "yahoo" ? "start" : "end",
    completeMinuteCount, minuteError, dailyError,
    daily: { count: basis?.closes.length ?? 0, requiredCount: days - 1, from: basis?.closes.at(0)?.date ?? null, to: basis?.closes.at(-1)?.date ?? null, historySum: sum, adjustment: basis?.adjustment ?? null },
    fetchedAt: simulatedFailure ? null : result.fetchedAt,
    durationMs: result.durationMs,
    pass: !simulatedFailure && !minuteError && completeMinuteCount === 10 && !dailyError && sum !== null,
  };
}

export async function diagnoseInstrument(
  instrument: Instrument,
  options: { days: number; forceFailover?: boolean; now?: number },
  source: typeof fetchSource = fetchSource,
): Promise<DiagnosticResult> {
  if (!Number.isInteger(options.days) || options.days < 2 || options.days > 500) throw new Error("均线天数必须为 2–500 的整数");
  const now = options.now ?? Date.now();
  const selection = selectDiagnosticWindow(instrument.market, now);
  const providers: ProviderDiagnostic[] = [];
  if (selection.window) {
    const window = selection.window;
    const primary: Provider = instrument.market === "cn" ? "tencent" : "yahoo";
    for (const provider of [primary, "eastmoney"] as const) {
      const simulated = !!options.forceFailover && provider === primary;
      let result: SourceResult;
      if (simulated) result = { provider, bars: [], basis: null, fetchedAt: new Date(now).toISOString(), durationMs: 0, error: "主来源模拟失败：未发出请求" };
      else {
        try { result = await source(provider, instrument, window, options.days, null, { timeoutMs: 5000 }); }
        catch { result = { provider, bars: [], basis: null, fetchedAt: new Date().toISOString(), durationMs: 0, error: "行情诊断请求失败" }; }
      }
      providers.push(summarize(result, provider === primary ? "primary" : "backup", window, options.days, now, simulated));
    }
  }
  const dualSourcePass = providers.length === 2 && providers.every((provider) => provider.pass);
  const pass = options.forceFailover ? providers.some((provider) => provider.role === "backup" && provider.pass) : dualSourcePass;
  return {
    symbol: instrument.code, market: instrument.market, days: options.days,
    mode: options.forceFailover ? "forced-failover" : "normal", checkedAt: new Date(now).toISOString(),
    coverage: selection.kind, label: selection.label,
    window: selection.window ? { sessionDate: selection.window.sessionDate, start: new Date(selection.window.start).toISOString(), end: new Date(selection.window.end).toISOString() } : null,
    primaryError: providers.find((provider) => provider.role === "primary")?.minuteError ?? null,
    providers, pass, dualSourcePass, freshnessConfirmed: selection.kind === "intraday" && pass,
  };
}

async function main() {
  const options = parseDiagnosticArgs(process.argv.slice(2));
  let failed = false;
  for (const instrument of DIAGNOSTIC_INSTRUMENTS.filter((item) => options.market === "all" || item.market === options.market)) {
    const result = await diagnoseInstrument(instrument, options);
    console.log(JSON.stringify(result));
    if (!result.pass) failed = true;
  }
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    console.error(JSON.stringify({ pass: false, error: "诊断参数或执行失败；用法：diagnose.ts [cn|us|all] [--days 2..500] [--force-failover]" }));
    process.exitCode = 2;
  });
}
