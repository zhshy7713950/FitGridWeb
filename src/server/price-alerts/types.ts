export type Market = "cn" | "us";
export type Provider = "tencent" | "eastmoney" | "yahoo";
export type Direction = "up" | "down";
export type AlertCondition =
  | { kind: "price"; direction: Direction; targetPrice: string }
  | { kind: "ma_touch"; direction: Direction; days: number }
  | { kind: "ma_deviation"; direction: Direction; days: number; percent: string };

export interface Instrument {
  id: string;
  code: string;
  name: string;
  market: Market;
  currency: "CNY" | "USD";
  kind: "stock" | "etf";
  tencent: string | null;
  yahoo: string | null;
  eastmoney: string | null;
}
export interface MinuteBar { start: number; end: number; open: string; high: string; low: string; close: string }
export interface DailyClose { date: string; close: string }
export interface DailyBasis { provider: Provider; sessionDate: string; closes: DailyClose[]; fetchedAt: string; adjustment: string }
export interface ScanWindow {
  market: Market; sessionDate: string; segmentStart: number; segmentEnd: number;
  start: number; end: number; runAt: number; deadline: number; kind: "intraday" | "closing";
}
export interface EvaluationState { armed: boolean; cursor: number | null; activeFrom: number }
export interface Trigger { minuteStart: number; minuteEnd: number; price: string; threshold: string; ma: string | null }
export interface SourceResult { provider: Provider; bars: MinuteBar[]; basis: DailyBasis | null; fetchedAt: string; durationMs: number; error: string | null; dailyError?: string | null }

export interface InstrumentCandidate {
  code: string; name: string; market: "cn" | "us"; currency: "CNY" | "USD"; kind: "stock" | "etf"; exchange: string;
}
