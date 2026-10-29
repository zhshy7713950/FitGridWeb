import { expect, it } from "vitest";
import { formatPrice } from "./price-display";

it.each([
  ["35.13999938964844", "us", "etf", "35.14"],
  ["34.9976005554", "us", "stock", "35.00"],
  ["32.9986855964", "us", "etf", "33.00"],
  ["6.9284992218", "cn", "etf", "6.928"],
  ["6.92", "cn", "etf", "6.920"],
  ["6.925", "cn", "stock", "6.93"],
  ["99999999999999999999.125", "us", "stock", "99999999999999999999.13"],
  ["0", "us", "stock", "0.00"],
  [null, "cn", "etf", "—"],
  [undefined, "us", "stock", "—"],
] as const)("formats %s for %s %s without floating-point tails", (value, market, kind, expected) => {
  expect(formatPrice(value, { market, kind })).toBe(expected);
});
