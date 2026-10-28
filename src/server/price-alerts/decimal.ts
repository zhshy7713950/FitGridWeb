import Decimal from "decimal.js";

// Local configuration must not change the Android-compatible grid calculations.
export const PriceDecimal = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
