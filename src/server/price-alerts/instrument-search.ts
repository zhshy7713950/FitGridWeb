import { fetchJson, fetchText } from "./market-data";
import type { InstrumentCandidate, Market } from "./types";

type Options = Parameters<typeof fetchText>[1];
const usExchanges: Record<string, string> = { NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ", NYQ: "NYSE", ASE: "NYSE American", PCX: "NYSE Arca", BTS: "Cboe BZX", BATS: "Cboe BZX" };
export async function searchInstruments(market: Market, query: string, options: Options): Promise<InstrumentCandidate[]> {
  const input = query.trim();
  const rows: InstrumentCandidate[] = [];
  if (market === "cn") {
    const explicit = /^\d{6}\.(SH|SZ)$/i.test(input) ? input.toUpperCase() : null;
    const text = await fetchText(`https://smartbox.gtimg.cn/s3/?q=${encodeURIComponent(input.replace(/\.(SH|SZ)$/i, ""))}&t=all`, options, "gb18030");
    const match = text.trim().match(/^v_hint=("(?:[^"\\]|\\.)*");?$/);
    if (!match) throw new Error("产品检索返回格式异常");
    const hints = (JSON.parse(match[1]) as string).replace(/\\u([a-f0-9]{4})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
    for (const hint of hints.split("^")) {
      const [exchange, code, name, , kind] = hint.split("~");
      if (!["sh", "sz"].includes(exchange) || !/^\d{6}$/.test(code) || !name || !["GP", "ETF"].includes(kind)) continue;
      if (exchange === "sh" ? !/^[65]/.test(code) : !/^(?:0|3|15)/.test(code)) continue;
      const canonical = `${code}.${exchange.toUpperCase()}`;
      if (explicit && canonical !== explicit) continue;
      rows.push({ code: canonical, name: name.slice(0, 160), market, currency: "CNY", kind: kind === "ETF" ? "etf" : "stock", exchange: exchange === "sh" ? "上海证券交易所" : "深圳证券交易所" });
    }
  } else {
    const body = await fetchJson(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(input.replace(/\.US$/i, ""))}&quotesCount=10&newsCount=0`, options);
    if (!body || typeof body !== "object" || !("quotes" in body) || !Array.isArray(body.quotes)) throw new Error("产品检索返回格式异常");
    for (const value of body.quotes) {
      if (!value || typeof value !== "object") continue;
      const row = value as Record<string, unknown>;
      if (typeof row.symbol !== "string" || !/^[A-Z][A-Z0-9.-]{0,14}$/.test(row.symbol) || typeof row.exchange !== "string" || !Object.hasOwn(usExchanges, row.exchange) || !["EQUITY", "ETF"].includes(String(row.quoteType))) continue;
      const name = row.longname ?? row.shortname;
      if (typeof name !== "string" || !name.trim()) continue;
      rows.push({ code: `${row.symbol}.US`, name: name.slice(0, 160), market, currency: "USD", kind: row.quoteType === "ETF" ? "etf" : "stock", exchange: usExchanges[row.exchange] });
    }
  }
  return [...new Map(rows.map((row) => [row.code, row])).values()].slice(0, 10);
}
