import Decimal from "decimal.js";
import type { Instrument } from "./types";

export function formatPrice(value: string | null | undefined, instrument: Pick<Instrument, "market" | "kind">): string {
  if (value == null) return "—";
  const places = instrument.market === "cn" && instrument.kind === "etf" ? 3 : 2;
  return new Decimal(value).toFixed(places, Decimal.ROUND_HALF_UP);
}
