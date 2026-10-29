import type DecimalType from "decimal.js";
import { PriceDecimal as Decimal } from "./decimal";
import { z } from "zod";
import type { AlertCondition, EvaluationState, MinuteBar, Trigger } from "./types";

const direction = z.enum(["up", "down"]);
const positiveDecimal = z.string().regex(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,10})?$/).refine((v) => new Decimal(v).gt(0), "价格必须大于零");
const days = z.number().int().min(2).max(500);
export const ruleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("price"), direction, targetPrice: positiveDecimal }),
  z.strictObject({ kind: z.literal("ma_touch"), direction, days }),
  z.strictObject({ kind: z.literal("ma_deviation"), direction, days,
    percent: z.string().regex(/^\d{1,2}(?:\.\d{1,2})?$/).refine((v) => new Decimal(v).gte("0.01") && new Decimal(v).lte("99.99"), "百分比范围为 0.01–99.99"),
  }),
]);

export function triggerThreshold(rule: AlertCondition, sum?: string): DecimalType {
  if (rule.kind === "price") return new Decimal(rule.targetPrice);
  if (!sum || !new Decimal(sum).gt(0)) throw new Error("均线历史数据不足");
  const multiplier = rule.kind === "ma_touch" ? new Decimal(1)
    : new Decimal(1).plus(new Decimal(rule.percent).div(100).mul(rule.direction === "up" ? 1 : -1));
  return new Decimal(sum).mul(multiplier).div(new Decimal(rule.days).minus(multiplier));
}

export function evaluateBars(rule: AlertCondition, initial: EvaluationState, bars: MinuteBar[], sum?: string) {
  const threshold = triggerThreshold(rule, sum);
  const state = { ...initial };
  const events: Trigger[] = [];
  const meets = (price: string) => rule.direction === "up" ? new Decimal(price).gte(threshold) : new Decimal(price).lte(threshold);
  for (const bar of [...bars].sort((a, b) => a.start - b.start)) {
    if (bar.start < state.activeFrom || (state.cursor !== null && bar.end <= state.cursor)) continue;
    const price = rule.direction === "up" ? bar.high : bar.low;
    if (state.armed && meets(price)) {
      events.push({ minuteStart: bar.start, minuteEnd: bar.end, price, threshold: threshold.toString(),
        ma: rule.kind === "price" ? null : new Decimal(sum!).plus(price).div(rule.days).toString() });
      state.armed = false;
    }
    if (!meets(bar.close)) state.armed = true;
    state.cursor = bar.end;
  }
  return { state, events };
}
