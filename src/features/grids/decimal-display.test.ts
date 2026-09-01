import { expect, it } from "vitest";

import { formatDecimal } from "./decimal-display";

it.each([
  ["2000", "2,000"],
  ["12345678901234567890.5000", "12,345,678,901,234,567,890.5000"],
  ["-1200.05", "-1,200.05"],
  ["0.9400", "0.9400"],
])("formats %s without losing decimal text", (value, expected) => {
  expect(formatDecimal(value)).toBe(expected);
});
