import { ClientApiError } from "@/lib/api-client";
import type { AlertDTO, AlertInput, AlertPage, ChannelStatus, EventPage, Instrument } from "./types";

const stamp = "2026-10-27T03:00:00.000Z";
const instruments: Instrument[] = [
  { id: "demo-inst-1", code: "518880", name: "黄金 ETF", market: "cn", currency: "CNY", kind: "etf", tencent: "sh518880", yahoo: "518880.SS", eastmoney: "1.518880" },
  { id: "demo-inst-2", code: "AAPL", name: "Apple", market: "us", currency: "USD", kind: "stock", tencent: "usAAPL", yahoo: "AAPL", eastmoney: "105.AAPL" },
  { id: "demo-inst-3", code: "510300", name: "沪深 300 ETF", market: "cn", currency: "CNY", kind: "etf", tencent: "sh510300", yahoo: "510300.SS", eastmoney: "1.510300" },
];
function makeRule(instrument: Instrument, index: number, input: AlertInput): AlertDTO {
  const price = instrument.market === "us" ? "236.48" : instrument.code === "510300" ? "4.126" : "6.872";
  const ma = instrument.market === "us" ? "237.10" : instrument.code === "510300" ? "4.010" : "6.910";
  return { id: `demo-alert-${index}`, instrument: { ...instrument, quote: { price, provider: instrument.market === "us" ? "yahoo" : "tencent", minuteStart: stamp, minuteEnd: "2026-10-27T03:01:00.000Z", fetchedAt: "2026-10-27T03:01:15.000Z" } }, ...input, version: 1, armed: true, activeFrom: stamp, cursor: stamp, continuityDegraded: false, lastError: null, lastSuccess: stamp, deletedAt: null, createdAt: stamp, updatedAt: stamp, lastEvaluation: { price, provider: instrument.market === "us" ? "yahoo" : "tencent", minuteEnd: stamp, fetchedAt: stamp, ma: input.condition.kind === "price" ? null : ma, threshold: input.condition.kind === "price" ? input.condition.targetPrice : input.condition.kind === "ma_deviation" ? "4.2105" : ma, adjustment: "前复权" } };
}
let rules = [makeRule(instruments[0], 1, { condition: { kind: "price", direction: "up", targetPrice: "6.9200" }, enabled: true }), makeRule(instruments[1], 2, { condition: { kind: "ma_touch", direction: "down", days: 20 }, enabled: true }), makeRule(instruments[2], 3, { condition: { kind: "ma_deviation", direction: "up", days: 60, percent: "5.00" }, enabled: false })];
let status: ChannelStatus = { configured: true, tested: true, testedAt: stamp, lastError: null, encryptionReady: true };
function get(id: string) {
  const rule = rules.find((item) => item.id === id);
  if (!rule) throw new ClientApiError(404, "NOT_FOUND", "提醒不存在");
  return structuredClone(rule);
}
export const demoApi = {
  list(): AlertPage { return { items: structuredClone(rules.filter((rule) => !rule.deletedAt)), status: { calendarWarnings: [], nextRunAt: "2026-10-27T03:10:15Z", lastScan: null } }; },
  get,
  events(id: string, before?: string): EventPage {
    const rule = get(id);
    if (before) return { items: [], nextCursor: null };
    return { items: [{ id: `event-${id}`, minuteStart: "2026-10-26T06:20:00Z", minuteEnd: "2026-10-26T06:21:00Z", price: rule.lastEvaluation!.threshold, threshold: rule.lastEvaluation!.threshold, ma: rule.lastEvaluation!.ma, provider: rule.lastEvaluation!.provider, evidence: { condition: rule.condition }, delivery: { status: "accepted", lastError: null, acceptedAt: "2026-10-26T06:30:18Z", attempts: 1 } }], nextCursor: null };
  },
  resolve(market: "cn" | "us", code: string): Instrument {
    const instrument = instruments.find((item) => item.market === market && item.code === code.toUpperCase());
    if (!instrument) throw new ClientApiError(404, "NOT_FOUND", "演示中可使用 518880、510300 或 AAPL");
    return structuredClone(instrument);
  },
  create(input: AlertInput & { instrumentId: string }) {
    const instrument = instruments.find((item) => item.id === input.instrumentId)!;
    const rule = makeRule(instrument, rules.length + 1, input); rules.push(rule); return structuredClone(rule);
  },
  update(id: string, input: Partial<AlertInput> & { expectedVersion: number }) {
    const current = get(id);
    if (current.version !== input.expectedVersion) throw new ClientApiError(409, "EDIT_CONFLICT", "提醒已更新");
    const next = { ...current, ...input, version: current.version + 1 };
    rules = rules.map((rule) => rule.id === id ? next : rule); return structuredClone(next);
  },
  remove(id: string) { rules = rules.map((rule) => rule.id === id ? { ...rule, deletedAt: stamp, enabled: false } : rule); },
  channel() { return { ...status }; },
  saveChannel() { status = { ...status, configured: true, tested: false, testedAt: null }; rules = rules.map((rule) => ({ ...rule, enabled: false, version: rule.version + 1 })); return { ...status }; },
  removeChannel() { status = { ...status, configured: false, tested: false, testedAt: null }; rules = rules.map((rule) => ({ ...rule, enabled: false, version: rule.version + 1 })); },
  testChannel(): { accepted: true } { status = { ...status, tested: true, testedAt: stamp }; return { accepted: true }; },
};
