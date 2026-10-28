export type AlertCondition =
  | { kind: "price"; direction: "up" | "down"; targetPrice: string }
  | { kind: "ma_touch"; direction: "up" | "down"; days: number }
  | { kind: "ma_deviation"; direction: "up" | "down"; days: number; percent: string };
export interface Instrument {
  id: string; code: string; name: string; market: "cn" | "us";
  currency: "CNY" | "USD"; kind: "stock" | "etf";
  tencent: string | null; yahoo: string | null; eastmoney: string | null;
}
export interface Quote {
  price: string; provider: string; minuteStart: string; minuteEnd: string; fetchedAt: string;
}
export interface AlertDTO {
  id: string; instrument: Instrument & { quote: Quote | null }; condition: AlertCondition;
  enabled: boolean; version: number; armed: boolean; activeFrom: string; cursor: string | null;
  continuityDegraded: boolean; lastError: string | null; lastSuccess: string | null;
  deletedAt: string | null; createdAt: string; updatedAt: string;
  lastEvaluation: { price: string; provider: string; minuteEnd: string; fetchedAt: string;
    ma: string | null; threshold: string; adjustment: string | null } | null;
}
export interface AlertPage {
  items: AlertDTO[];
  status: { calendarWarnings: string[]; nextRunAt: string | null; lastScan: unknown | null };
}
export interface EventDTO {
  id: string; minuteStart: string; minuteEnd: string; price: string; threshold: string;
  ma: string | null; provider: string; evidence: { delayed?: boolean; condition?: AlertCondition };
  delivery: { status: "pending" | "sending" | "accepted" | "failed" | "cancelled" | "expired" | "history";
    lastError: string | null; acceptedAt: string | null; attempts: number };
}
export interface EventPage { items: EventDTO[]; nextCursor: string | null }
export interface ChannelStatus {
  configured: boolean; tested: boolean; testedAt: string | null; lastError: string | null; encryptionReady: boolean;
}
export interface AlertInput { condition: AlertCondition; enabled: boolean }

export interface InstrumentCandidate {
  code: string; name: string; market: "cn" | "us"; currency: "CNY" | "USD"; kind: "stock" | "etf"; exchange: string;
}
