export type Metric = "price" | "pe" | "pb";
export type Source = "tencent" | "yahoo" | "csi" | "legu";
export interface SeriesDefinition {
  key: string; subject: string; metric: Metric; source: Source; symbol: string;
  method: string; frequency: "daily" | "monthly"; sourceLabel: string;
}
export interface Observation { date: string; value: string | null; quality: "valid" | "non_positive" | "missing" | "gap" }
export interface ValuationProduct {
  code: string; name: string; market: "cn" | "us"; currency: "CNY" | "USD";
  kind: "etf" | "lof" | "reit"; benchmark: { id: string; name: string } | null;
  mappingSince: string | null; note: string | null; series: Record<Metric, SeriesDefinition | null>;
}
export interface SeriesRequest { series: SeriesDefinition; from: string; to: string; allowEmpty?: boolean }
export interface SeriesBatch { observations: Observation[]; reachedStart: boolean }
export interface MetricSummary {
  min: string | null; max: string | null; p30: string | null; p70: string | null;
  currentValue: string | null; currentPercentile: string | null; latestDate: string | null;
  latestValidDate: string | null; validCount: number; referenceCount: number; start: string | null; end: string | null;
}
export interface PricePoint { date: string; close: string | null; ma250: string | null; ma500: string | null }
export interface SeriesSnapshot {
  definition: SeriesDefinition; observations: Observation[]; checkedAt: string | null;
  lastAttemptAt: string | null; retryAt: string | null; leaseUntil: string | null;
  cursor: string | null; complete: boolean; failures: number; error: string | null;
}
export interface MetricCard {
  availability: "ready" | "empty" | "unsupported" | "not_applicable" | "error";
  stale: boolean; refreshing: boolean; due: boolean; source: string | null; method: string | null;
  frequency: "daily" | "monthly" | null; asOf: string | null; checkedAt: string | null;
  coverage: "none" | "partial" | "source_history"; message: string | null;
  points: Observation[]; stats: MetricSummary; prices?: PricePoint[];
}
export interface ValuationPageData {
  product: { id: string; code: string; name: string; currency: string | null };
  benchmark: ValuationProduct["benchmark"]; note: string | null;
  price: MetricCard; pe: MetricCard; pb: MetricCard;
  refresh: { busy: boolean; hasMore: boolean; retryAfter: number | null };
}
