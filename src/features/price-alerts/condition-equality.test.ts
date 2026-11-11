import { expect, it } from "vitest";
import { conditionsEqual } from "./condition-equality";
import type { AlertCondition } from "./types";

const price: AlertCondition = { kind: "price", direction: "up", targetPrice: "10" };
const deviation: AlertCondition = { kind: "ma_deviation", direction: "down", days: 20, percent: "5" };
it.each<[AlertCondition, AlertCondition, boolean]>([
  [price, { ...price, targetPrice: "10.00" }, true],
  [price, { ...price, targetPrice: "11" }, false],
  [price, { ...price, direction: "down" }, false],
  [{ ...price, targetPrice: "99999999999999999999.0000000001" }, { ...price, targetPrice: "99999999999999999999.0000000002" }, false],
  [price, { kind: "ma_touch", direction: "up", days: 10 }, false],
  [{ kind: "ma_touch", direction: "up", days: 20 }, { kind: "ma_touch", direction: "up", days: 20 }, true],
  [{ kind: "ma_touch", direction: "up", days: 20 }, { kind: "ma_touch", direction: "up", days: 21 }, false],
  [deviation, { ...deviation, percent: "05.00" }, true],
  [deviation, { ...deviation, percent: "5.01" }, false],
  [deviation, { ...deviation, days: 21 }, false],
  [deviation, { ...deviation, direction: "up" }, false],
])("compares %j and %j as %s without losing decimal precision", (left, right, equal) => {
  expect(conditionsEqual(left, right)).toBe(equal);
  expect(conditionsEqual(right, left)).toBe(equal);
});
