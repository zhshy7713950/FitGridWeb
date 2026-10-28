import { PriceDecimal as Decimal } from "./decimal";
import { dateInZone, localTimeUtc, segments, ZONES } from "./calendar";
import type { DailyBasis, DailyClose, Instrument, Market, MinuteBar, Provider, ScanWindow, SourceResult } from "./types";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {}; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("行情数据格式异常"); return value; }
function price(value: unknown): string {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") throw new Error("行情价格字段异常");
  const result = new Decimal(value);
  if (!result.isFinite() || !result.gt(0) || result.gte("1e20")) throw new Error("行情价格字段异常");
  return result.toString();
}
function minute(start: number, open: unknown, close: unknown, high: unknown, low: unknown): MinuteBar {
  const b = { start, end: start + 60000, open: price(open), close: price(close), high: price(high), low: price(low) };
  if (!Number.isFinite(start) || start % 60000 || new Decimal(b.high).lt(Decimal.max(b.open, b.close, b.low)) || new Decimal(b.low).gt(Decimal.min(b.open, b.close, b.high))) throw new Error("分钟 OHLC 字段异常");
  return b;
}
function yahooData(body: unknown, product: Instrument, granularity: string) {
  const chart = object(object(body).chart);
  if (chart.error) throw new Error("Yahoo 返回业务错误");
  const d = object(array(chart.result)[0]);
  const meta = object(d.meta);
  if (meta.symbol !== product.yahoo || meta.dataGranularity !== granularity || meta.currency && meta.currency !== product.currency) throw new Error("Yahoo 标的、币种或粒度不匹配");
  return d;
}
function eastmoneyData(body: unknown, product: Instrument) {
  const root = object(body); const d = object(root.data);
  if (root.rc !== 0) throw new Error("东方财富返回业务错误");
  if (`${d.market}.${d.code}` !== product.eastmoney) throw new Error("东方财富标的不匹配");
  return d;
}
function tencentData(body: unknown, product: Instrument) {
  const root = object(body);
  if (root.code !== 0 || !product.tencent) throw new Error("腾讯返回业务错误");
  const d = object(object(root.data)[product.tencent]);
  const quote = object(d.qt)[product.tencent];
  if (Array.isArray(quote) && String(quote[2]) !== product.code.split(".")[0]) throw new Error("腾讯标的不匹配");
  return d;
}

export function parseMinutes(provider: Provider, body: unknown, product: Instrument, context?: { window: ScanWindow; receivedAt: number }): MinuteBar[] {
  const included = (start: number) => !context || start >= context.window.start && start + 60000 <= context.window.end && start + 60000 <= context.receivedAt;
  if (provider === "tencent") return array(tencentData(body, product).m1).flatMap((value) => {
    const r = array(value); const stamp = String(r[0]);
    if (!/^\d{12}$/.test(stamp)) throw new Error("腾讯分钟时间格式异常");
    const date = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
    const start = localTimeUtc(date, `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}`, ZONES.cn) - 60000;
    return included(start) ? [minute(start, r[1], r[2], r[3], r[4])] : [];
  });
  if (provider === "eastmoney") return array(eastmoneyData(body, product).klines).flatMap((line) => {
    const r = String(line).split(",");
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r[0])) throw new Error("东方财富分钟时间异常");
    const start = localTimeUtc(r[0].slice(0, 10), r[0].slice(11), ZONES.cn) - 60000;
    return included(start) ? [minute(start, r[1], r[2], r[3], r[4])] : [];
  });
  const d = yahooData(body, product, "1m");
  const q = object(array(object(d.indicators).quote)[0]);
  return array(d.timestamp).flatMap((stamp, index) => {
    if (typeof stamp !== "number" || !Number.isFinite(stamp)) throw new Error("Yahoo 分钟时间异常");
    const start = stamp * 1000;
    if (!included(start)) return [];
    const values = ["open", "close", "high", "low"].map((key) => array(q[key])[index]);
    if (values.some((v) => v === null)) return [];
    return [minute(start, values[0], values[1], values[2], values[3])];
  });
}

export function assessWindow(bars: MinuteBar[], window: ScanWindow, receivedAt: number) {
  const regular = segments(window.market, window.sessionDate);
  const unique = new Map<number, MinuteBar>();
  for (const b of bars) {
    if (b.end > receivedAt || !regular.some((s) => b.start >= s.start && b.end <= s.end)) continue;
    const prior = unique.get(b.start);
    if (prior && ["open", "high", "low", "close"].some((key) => prior[key as keyof MinuteBar] !== b[key as keyof MinuteBar])) throw new Error("同一分钟存在冲突价格");
    unique.set(b.start, b);
  }
  const missing: string[] = [];
  for (let start = window.start; start < window.end; start += 60000) if (!unique.has(start)) missing.push(new Date(start).toISOString());
  return { bars: [...unique.values()].filter((b) => b.start >= window.start && b.end <= window.end).sort((a, b) => a.start - b.start), missing };
}

export function parseDaily(provider: Provider, body: unknown, product: Instrument, sessionDate: string, fetchedAt: string): DailyBasis {
  let rows: DailyClose[];
  if (provider === "yahoo") {
    const d = yahooData(body, product, "1d");
    const indicators = object(d.indicators);
    const adj = array(object(array(indicators.adjclose)[0]).adjclose);
    const raw = array(object(array(indicators.quote)[0]).close);
    rows = array(d.timestamp).flatMap((stamp, index) => {
      const date = dateInZone(Number(stamp) * 1000, ZONES.us);
      if (date === sessionDate && adj[index] != null && raw[index] != null && new Decimal(price(adj[index])).div(price(raw[index])).minus(1).abs().gt("0.0001")) throw new Error("Yahoo 当前价格复权尺度不匹配");
      return adj[index] === null ? [] : [{ date, close: price(adj[index]) }];
    });
  } else if (provider === "tencent") {
    const d = tencentData(body, product);
    rows = array(d.qfqday ?? d.day).map((value) => { const r = array(value); return { date: String(r[0]), close: price(r[2]) }; });
  } else {
    rows = array(eastmoneyData(body, product).klines).map((value) => { const r = String(value).split(","); return { date: r[0], close: price(r[2]) }; });
  }
  const unique = new Map<string, string>();
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date) throw new Error("日线交易日期异常");
    if (row.date >= sessionDate) continue;
    if (unique.has(row.date) && unique.get(row.date) !== row.close) throw new Error("日线数据冲突");
    unique.set(row.date, row.close);
  }
  if (!unique.size) throw new Error("均线日线数据不足");
  const basis = { provider, sessionDate, fetchedAt, adjustment: provider === "yahoo" ? "Yahoo adjusted close (splits/dividends)" : "前复权 qfq", closes: [...unique].sort(([a], [b]) => a.localeCompare(b)).slice(-499).map(([date, close]) => ({ date, close })) };
  assertDailyBasis(basis, product.market, sessionDate, provider);
  return basis;
}
export function assertDailyBasis(basis: DailyBasis, market: Market, sessionDate: string, provider = basis.provider) {
  if (basis.sessionDate !== sessionDate || basis.provider !== provider || !Array.isArray(basis.closes) || !basis.closes.length) throw new Error("均线日线来源或日期不匹配");
  let previous = "";
  for (const row of basis.closes) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date <= previous || row.date >= sessionDate || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date) throw new Error("均线日线日期异常");
    price(row.close); previous = row.date;
  }
  const latest = basis.closes.at(-1)!.date;
  if ([0, 6].includes(new Date(`${latest}T12:00:00Z`).getUTCDay())) throw new Error("均线日线交易日期异常");
  try { if (!segments(market, latest).length) throw new Error("均线日线交易日期异常"); }
  catch (error) { if (!(error instanceof Error) || !error.message.includes("尚未覆盖")) throw error; }
  const first = Date.parse(`${latest}T12:00:00Z`) + 86400000;
  const end = Date.parse(`${sessionDate}T12:00:00Z`);
  if (end - first > 32 * 86400000) throw new Error("均线日线滞后，停牌或数据延迟无法确认");
  for (let day = first; day < end; day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (segments(market, date).length) throw new Error("均线日线滞后，停牌或数据延迟无法确认");
  }
}
export function historySum(basis: DailyBasis, days: number): string {
  if (basis.closes.length < days - 1) throw new Error("均线历史数据不足");
  return basis.closes.slice(-(days - 1)).reduce((sum, row) => sum.plus(row.close), new Decimal(0)).toString();
}

interface RequestOptions { signal?: AbortSignal; timeoutMs?: number; beforeRequest?: () => Promise<void> }
async function fetchText(url: string, options: RequestOptions = {}, encoding = "utf-8") {
  await options.beforeRequest?.();
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 5000), ...(options.signal ? [options.signal] : [])]);
  const response = await fetch(url, { signal, redirect: "error", headers: { "user-agent": "FitGrid/1.0 (personal price alerts)", accept: "application/json" } });
  if (!response.ok) throw new Error(`行情返回 HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > 2_000_000) throw new Error("行情响应过大");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("行情空响应");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > 2_000_000) throw new Error("行情响应过大"); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  return new TextDecoder(encoding).decode(Buffer.concat(chunks));
}
export async function fetchJson(url: string, options: RequestOptions = {}): Promise<unknown> {
  const text = await fetchText(url, options);
  try { return JSON.parse(text); } catch { throw new Error("行情响应不是有效 JSON"); }
}
export function sourceUrl(provider: Provider, product: Instrument, daily = false): string {
  if (provider === "tencent") return daily
    ? `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${product.tencent},day,,,640,qfq`
    : `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${product.tencent},m1,,50`;
  if (provider === "yahoo") return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(product.yahoo!)}?interval=${daily ? "1d&range=5y&includeAdjustedClose=true" : "1m&range=1d"}&includePrePost=false`;
  return `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${encodeURIComponent(product.eastmoney!)}&klt=${daily ? 101 : 1}&fqt=${daily ? 1 : 0}&lmt=${daily ? 600 : 50}&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56`;
}

export async function fetchDailyBasis(provider: Provider, product: Instrument, sessionDate: string, options: RequestOptions): Promise<DailyBasis> {
  return parseDaily(provider, await fetchJson(sourceUrl(provider, product, true), options), product, sessionDate, new Date().toISOString());
}

export async function selectSources(primary: SourceResult, needsMA: boolean, backupFetch: () => Promise<SourceResult>, requiredDays = 2) {
  const price = primary.error ? null : primary;
  const ma = price?.basis && price.basis.closes.length >= requiredDays - 1 ? price : null;
  if (price && (!needsMA || ma)) return { price, ma, backup: null };
  const backup = await backupFetch();
  return { price: price ?? (backup.error ? null : backup), ma: ma ?? (!backup.error && backup.basis ? backup : null), backup };
}

export async function fetchSource(provider: Provider, product: Instrument, window: ScanWindow, requiredDays: number, basis: DailyBasis | null, options: RequestOptions): Promise<SourceResult> {
  const started = performance.now(); let bars: MinuteBar[] = []; let error: string | null = null;
  let dailyError: string | null = null;
  if (basis) { try { assertDailyBasis(basis, product.market, window.sessionDate, provider); } catch { basis = null; } }
  try {
    const body = await fetchJson(sourceUrl(provider, product), options);
    const receivedAt = Date.now();
    const assessed = assessWindow(parseMinutes(provider, body, product, { window, receivedAt }), window, receivedAt);
    if (assessed.missing.length) throw new Error(`分钟覆盖不完整，缺少 ${assessed.missing.length} 分钟`);
    bars = assessed.bars;
    if (requiredDays > 0 && (!basis || basis.closes.length < requiredDays - 1)) {
      try { basis = parseDaily(provider, await fetchJson(sourceUrl(provider, product, true), options), product, window.sessionDate, new Date().toISOString()); }
      catch (cause) { basis = null; dailyError = cause instanceof Error && /^(均线日线|日线|Yahoo|腾讯|东方财富|行情返回 HTTP)/.test(cause.message) ? cause.message : "均线日线不可用"; }
    }
  } catch (cause) { error = cause instanceof Error && /^(分钟|行情|腾讯|Yahoo|东方|同一)/.test(cause.message) ? cause.message : "行情请求失败或超时"; }
  return { provider, bars, basis: basis?.sessionDate === window.sessionDate ? basis : null, fetchedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - started), error, ...(dailyError ? { dailyError } : {}) };
}

export async function resolveInstrument(market: Market, rawCode: string, options: RequestOptions = {}): Promise<Omit<Instrument, "id">> {
  const code = rawCode.trim().toUpperCase();
  let tencent: string | null = null; let yahoo: string | null = null; let canonical: string;
  if (market === "cn") {
    const match = /^(\d{6})\.(SH|SZ)$/.exec(code);
    if (!match || !(match[2] === "SH" ? /^[65]/ : /^(?:0|3|15)/).test(match[1])) throw new Error("请输入沪深股票或 ETF 代码，例如 600519.SH、159919.SZ");
    canonical = code; tencent = `${match[2].toLowerCase()}${match[1]}`;
  } else {
    yahoo = code.replace(/\.US$/, "");
    if (!/^[A-Z][A-Z0-9.-]{0,14}$/.test(yahoo)) throw new Error("美股代码格式无效");
    canonical = `${yahoo}.US`;
  }
  let name: string; let kind: "stock" | "etf";
  if (market === "cn") {
    const quote = await fetchText(`https://qt.gtimg.cn/q=${tencent}`, options, "gb18030");
    const fields = quote.match(/="([^"]+)"/)?.[1].split("~");
    if (!fields || fields[2] !== code.slice(0, 6) || !fields[1]) throw new Error("腾讯未找到对应沪深产品");
    name = fields[1]; kind = /ETF/i.test(name) ? "etf" : "stock";
    if (/^(?:5|15)/.test(code) && kind !== "etf") throw new Error("首版仅支持股票和场内 ETF");
    price(fields[3]);
  } else {
    const d = yahooData(await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahoo!)}?interval=1d&range=5d&includePrePost=false`, options), { yahoo, currency: "USD" } as Instrument, "1d");
    const meta = object(d.meta);
    if (meta.currency !== "USD" || !["EQUITY", "ETF"].includes(String(meta.instrumentType)) || meta.exchangeTimezoneName !== ZONES.us) throw new Error("首版仅支持美元计价的美股股票和 ETF");
    name = String(meta.longName ?? meta.shortName ?? yahoo); kind = meta.instrumentType === "ETF" ? "etf" : "stock";
  }
  let eastmoney: string | null = market === "cn" ? `${code.endsWith(".SH") ? 1 : 0}.${code.slice(0, 6)}` : null;
  if (market === "us") {
    try {
      const body = await fetchJson(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(yahoo!)}&type=14&count=10`, options);
      const rows = array(object(object(body).QuotationCodeTable).Data);
      const found = rows.map(object).find((r) => String(r.Code).toUpperCase() === yahoo && /^(105|106|107)\./.test(String(r.QuoteID)));
      if (found) eastmoney = String(found.QuoteID);
    } catch { /* A primary-only instrument is explicit in the resolve response. */ }
  }
  return { code: canonical, name: name.slice(0, 160), market, currency: market === "cn" ? "CNY" : "USD", kind, tencent, yahoo, eastmoney };
}
