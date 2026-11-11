import Decimal from "decimal.js";
import type { AlertCondition } from "./types";

export function conditionsEqual(left: AlertCondition, right: AlertCondition): boolean {
  if (left.kind !== right.kind || left.direction !== right.direction) return false;
  if (left.kind === "price" && right.kind === "price") return new Decimal(left.targetPrice).eq(right.targetPrice);
  if (left.kind === "ma_touch" && right.kind === "ma_touch") return left.days === right.days;
  return left.kind === "ma_deviation" && right.kind === "ma_deviation"
    && left.days === right.days && new Decimal(left.percent).eq(right.percent);
}
