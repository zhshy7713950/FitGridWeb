import Decimal from "decimal.js";

import { GridDomainError } from "./errors";
import type {
  GridCalculationResult,
  GridItemResult,
  GridTradeInput,
  GridType,
} from "./types";

Decimal.set({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

type DecimalGridItem = Omit<
  GridItemResult,
  | "gear"
  | "buyPrice"
  | "buyCount"
  | "buyAmount"
  | "sellPrice"
  | "sellCount"
  | "sellAmount"
  | "profitAmount"
  | "profitRate"
  | "keepProfit"
  | "keepCount"
> & {
  gear: Decimal;
  buyPrice: Decimal;
  buyCount: Decimal;
  buyAmount: Decimal;
  sellPrice: Decimal;
  sellCount: Decimal;
  sellAmount: Decimal;
  profitAmount: Decimal;
  profitRate: Decimal;
  keepProfit: Decimal;
  keepCount: Decimal;
};

const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const HUNDRED = new Decimal(100);

/** Round an exact Decimal value to the nearest IEEE-754 binary32 value. */
function float32(value: Decimal.Value): Decimal {
  const input = new Decimal(value);
  if (input.isZero()) return ZERO;

  const sign = input.isNegative() ? -1 : 1;
  const absolute = input.abs();
  let normalized = absolute;
  let exponent = 0;

  while (normalized.greaterThanOrEqualTo(2)) {
    normalized = normalized.div(2);
    exponent += 1;
  }
  while (normalized.lessThan(1)) {
    normalized = normalized.mul(2);
    exponent -= 1;
  }

  const unit = new Decimal(2).pow(exponent - 23);
  const units = absolute.div(unit).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN);
  const result = units.mul(unit);
  return sign < 0 ? result.negated() : result;
}

function fadd(left: Decimal, right: Decimal.Value): Decimal {
  return float32(left.add(right));
}

function fsub(left: Decimal, right: Decimal.Value): Decimal {
  return float32(left.sub(right));
}

function fmul(left: Decimal, right: Decimal.Value): Decimal {
  return float32(left.mul(right));
}

function fdiv(left: Decimal, right: Decimal.Value): Decimal {
  return float32(left.div(right));
}

/** Java Float.toString compatible for the finite values admitted by domain validation. */
function floatText(value: Decimal): string {
  const target = Math.fround(Number(value.toString()));
  if (Object.is(target, -0) || target === 0) return "0";
  for (let digits = 1; digits <= 9; digits += 1) {
    const candidate = target.toPrecision(digits);
    if (Object.is(Math.fround(Number(candidate)), target)) {
      return new Decimal(candidate).toString();
    }
  }
  return new Decimal(target.toPrecision(9)).toString();
}

function inputFloat(value: Decimal.Value): Decimal {
  return float32(value);
}

function androidRound(value: Decimal, places: number): Decimal {
  return float32(value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP));
}

function divide16(left: Decimal, right: Decimal): Decimal {
  return left.div(right).toDecimalPlaces(16, Decimal.ROUND_HALF_UP);
}

function quantity(amount: Decimal, price: Decimal, minimum: Decimal): Decimal {
  if (price.isZero() || minimum.isZero()) return ZERO;
  const amountBd = new Decimal(floatText(amount));
  const priceBd = new Decimal(floatText(price));
  const minimumBd = new Decimal(floatText(minimum));
  const lots = divide16(divide16(amountBd, priceBd), minimumBd).toDecimalPlaces(
    0,
    Decimal.ROUND_HALF_UP,
  );
  return float32(lots.mul(minimumBd));
}

function serializeItem(item: DecimalGridItem): GridItemResult {
  return {
    sequence: item.sequence,
    gridType: item.gridType,
    gear: floatText(item.gear),
    buyPrice: floatText(item.buyPrice),
    buyCount: floatText(item.buyCount),
    buyAmount: floatText(item.buyAmount),
    sellPrice: floatText(item.sellPrice),
    sellCount: floatText(item.sellCount),
    sellAmount: floatText(item.sellAmount),
    profitAmount: floatText(item.profitAmount),
    profitRate: floatText(item.profitRate),
    keepProfit: floatText(item.keepProfit),
    keepCount: floatText(item.keepCount),
  };
}

function totals(items: DecimalGridItem[]): GridCalculationResult {
  let totalBuyAmount = ZERO;
  let totalProfitAmount = ZERO;
  for (const item of items) {
    totalBuyAmount = fadd(totalBuyAmount, item.buyAmount);
    totalProfitAmount = fadd(totalProfitAmount, item.profitAmount);
  }
  const totalProfitRate = totalBuyAmount.isZero()
    ? ZERO
    : androidRound(fdiv(totalProfitAmount, totalBuyAmount), 4);
  totalBuyAmount = androidRound(totalBuyAmount, 2);
  totalProfitAmount = androidRound(totalProfitAmount, 2);

  return {
    items: items.map(serializeItem),
    totalBuyAmount: floatText(totalBuyAmount),
    totalProfitAmount: floatText(totalProfitAmount),
    totalProfitRate: floatText(totalProfitRate),
  };
}

interface PriceRow {
  gridType: GridType;
  gear: Decimal;
  buyPrice: Decimal;
  sellPrice: Decimal;
}

function priceRows(
  maxPrice: Decimal,
  amplitudeValue: Decimal.Value,
  maxAmplitude: number,
  gridType: GridType,
): PriceRow[] {
  const amplitude = inputFloat(amplitudeValue);
  const isLittle = gridType === 1;
  const count = Math.trunc(fdiv(inputFloat(maxAmplitude), amplitude).toNumber()) + (isLittle ? 1 : 0);
  const amplitudeBd = new Decimal(floatText(amplitude));
  let gearBd = isLittle ? HUNDRED : HUNDRED.sub(amplitudeBd);
  let previousBuyPrice: Decimal | null = null;
  const rows: PriceRow[] = [];

  for (let offset = 0; offset < count; offset += 1) {
    const gear = float32(gearBd);
    const buyPrice = androidRound(fdiv(fmul(maxPrice, gear), inputFloat(100)), 3);
    let sellPrice: Decimal;
    if (previousBuyPrice) {
      sellPrice = previousBuyPrice;
    } else if (isLittle) {
      const integerAmplitude = inputFloat(amplitude.trunc());
      const factor = fadd(ONE, fdiv(integerAmplitude, inputFloat(100)));
      sellPrice = androidRound(fmul(maxPrice, factor), 3);
    } else {
      sellPrice = maxPrice;
    }

    rows.push({ gridType, gear, buyPrice, sellPrice });
    previousBuyPrice = buyPrice;
    gearBd = gearBd.sub(amplitudeBd);
  }
  return rows;
}

function createLongItem(
  row: PriceRow,
  sequence: number,
  budget: Decimal,
  keepShare: number,
  minimum: Decimal,
): DecimalGridItem {
  const buyCount = quantity(budget, row.buyPrice, minimum);
  const buyAmount = androidRound(fmul(row.buyPrice, buyCount), 2);
  const profitAmount = androidRound(fmul(fsub(row.sellPrice, row.buyPrice), buyCount), 2);
  const profitRate = buyAmount.isZero() ? ZERO : androidRound(fdiv(profitAmount, buyAmount), 4);
  const retainedAmount = fmul(profitAmount, inputFloat(row.gridType === 1 ? keepShare : 0));
  const keepCount = quantity(retainedAmount, row.sellPrice, minimum);
  const keepProfit = androidRound(fmul(keepCount, row.sellPrice), 2);
  const sellCount = Decimal.max(ZERO, fsub(buyCount, keepCount));
  const sellAmount = androidRound(fmul(sellCount, row.sellPrice), 2);

  return {
    sequence,
    gridType: row.gridType,
    gear: row.gear,
    buyPrice: row.buyPrice,
    buyCount,
    buyAmount,
    sellPrice: row.sellPrice,
    sellCount,
    sellAmount,
    profitAmount,
    profitRate,
    keepProfit,
    keepCount,
  };
}

function buildLong(input: GridTradeInput): GridCalculationResult {
  const maxPrice = inputFloat(input.maxPrice);
  const minimum = inputFloat(input.minTradeQuantity);
  const littleRows = priceRows(maxPrice, input.gearAmplitude, input.maxAmplitude, 1);
  const mergedRows: PriceRow[] = [...littleRows];
  if (input.mediumAmplitude !== null) {
    mergedRows.push(...priceRows(maxPrice, input.mediumAmplitude, input.maxAmplitude, 2));
  }
  if (input.bigAmplitude !== null) {
    mergedRows.push(...priceRows(maxPrice, input.bigAmplitude, input.maxAmplitude, 3));
  }
  mergedRows.sort(
    (left, right) => right.gear.comparedTo(left.gear) || left.gridType - right.gridType,
  );

  const multiplierBase = ONE.add(divide16(new Decimal(input.increaseAmplitude), HUNDRED));
  const baseBudget = new Decimal(floatText(inputFloat(input.perShare)));
  const items = mergedRows.map((row, index) => {
    let exponent = littleRows.filter((little) => little.gear.greaterThanOrEqualTo(row.gear)).length;
    exponent -= 1;
    const budget = float32(multiplierBase.pow(Math.max(0, exponent)).mul(baseBudget));
    return createLongItem(row, index + 1, budget, input.keepShare, minimum);
  });

  return totals(items);
}

function buildShort(input: GridTradeInput): GridCalculationResult {
  const maxPrice = inputFloat(input.maxPrice);
  const minimum = inputFloat(input.minTradeQuantity);
  const amplitude = inputFloat(input.gearAmplitude);
  const baseBudget = inputFloat(input.perShare);
  const countPerSide = Math.trunc(fdiv(inputFloat(input.maxAmplitude), amplitude).toNumber());
  const amplitudeBd = new Decimal(floatText(amplitude));
  const priceBase = ONE.add(divide16(amplitudeBd, HUNDRED));
  const amountBase = ONE.add(divide16(new Decimal(input.increaseAmplitude), HUNDRED));
  const items: DecimalGridItem[] = [];

  for (let i = countPerSide; i >= 0; i -= 1) {
    const sellPrice =
      i > 0
        ? androidRound(float32(new Decimal(floatText(maxPrice)).mul(priceBase.pow(i))), 3)
        : maxPrice;
    const referenceAmount =
      i > 0
        ? androidRound(float32(new Decimal(floatText(baseBudget)).mul(amountBase.pow(i))), 2)
        : baseBudget;
    const sellCount = quantity(referenceAmount, sellPrice, minimum);
    const sellAmount = androidRound(fmul(sellCount, sellPrice), 2);
    const factor = fsub(ONE, fdiv(amplitude, inputFloat(100)));
    const buyPrice = androidRound(fmul(sellPrice, factor), 3);
    const buyCount = sellCount;
    const buyAmount = androidRound(fmul(buyCount, buyPrice), 2);
    const profitAmount = androidRound(fsub(sellAmount, buyAmount), 2);
    const profitRate = sellAmount.isZero()
      ? ZERO
      : androidRound(fdiv(profitAmount, sellAmount), 4);
    const gear = fsub(inputFloat(100), fmul(inputFloat(countPerSide - i), amplitude));

    items.push({
      sequence: items.length + 1,
      gridType: 1,
      gear,
      buyPrice,
      buyCount,
      buyAmount,
      sellPrice,
      sellCount,
      sellAmount,
      profitAmount,
      profitRate,
      keepProfit: ZERO,
      keepCount: ZERO,
    });
  }
  return totals(items);
}

export function calculateGrid(input: GridTradeInput): GridCalculationResult {
  if (input.algorithmVersion !== "android-v2.1.0") {
    throw new GridDomainError(
      "ALGORITHM_VERSION_UNSUPPORTED",
      `Unsupported grid algorithm: ${String(input.algorithmVersion)}`,
      "algorithmVersion",
    );
  }
  return input.isShort ? buildShort(input) : buildLong(input);
}
