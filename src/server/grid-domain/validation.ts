import Decimal from "decimal.js";

import { GridDomainError } from "./errors";
import type { GridTradeInput } from "./types";

const DECIMAL_PATTERN = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function fail(
  code: string,
  field: keyof GridTradeInput,
  message: string,
): never {
  throw new GridDomainError(code, message, field);
}

function parseDatabaseDecimal(
  value: unknown,
  field: "maxPrice" | "minTradeQuantity" | "gearAmplitude" | "perShare",
): Decimal {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    return fail("DECIMAL_FORMAT_INVALID", field, `${field} must be a plain finite decimal string`);
  }
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  const [integerPart, fractionPart = ""] = unsigned.split(".");
  if (integerPart.length > 20 || fractionPart.length > 10) {
    return fail("DECIMAL_PRECISION_EXCEEDED", field, `${field} exceeds numeric(30,10)`);
  }
  return new Decimal(value);
}

function requireInteger(
  value: unknown,
  field: "keepShare" | "increaseAmplitude" | "maxAmplitude" | "sortOrder",
  code: string,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return fail(code, field, `${field} must be a safe integer`);
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  field: "mediumAmplitude" | "bigAmplitude",
  code: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return fail(code, field, `${field} must be a positive integer or null`);
  }
  return value;
}

function normalizedOptionalText(value: unknown, field: "productName" | "category"): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    return fail("TEXT_FIELD_INVALID", field, `${field} must be a string or null`);
  }
  const normalized = value.trim();
  if (normalized.length > 120) {
    return fail("TEXT_FIELD_TOO_LONG", field, `${field} cannot exceed 120 characters`);
  }
  return normalized || null;
}

export function validateGridInput(input: GridTradeInput): GridTradeInput {
  if (!input || typeof input !== "object") {
    throw new GridDomainError("GRID_INPUT_INVALID", "Grid input must be an object");
  }
  if (input.algorithmVersion !== "android-v2.1.0") {
    fail(
      "ALGORITHM_VERSION_UNSUPPORTED",
      "algorithmVersion",
      `Unsupported grid algorithm: ${String(input.algorithmVersion)}`,
    );
  }

  const productCode = typeof input.productCode === "string" ? input.productCode.trim() : "";
  if (!productCode || productCode.length > 64) {
    fail(
      productCode ? "PRODUCT_CODE_TOO_LONG" : "PRODUCT_CODE_REQUIRED",
      "productCode",
      "productCode must contain 1 to 64 characters",
    );
  }

  const maxPrice = parseDatabaseDecimal(input.maxPrice, "maxPrice");
  const minimum = parseDatabaseDecimal(input.minTradeQuantity, "minTradeQuantity");
  const gear = parseDatabaseDecimal(input.gearAmplitude, "gearAmplitude");
  const budget = parseDatabaseDecimal(input.perShare, "perShare");
  if (!maxPrice.greaterThan(0)) {
    fail("MAX_PRICE_MUST_BE_GT_ZERO", "maxPrice", "maxPrice must be greater than zero");
  }
  if (!minimum.greaterThan(0)) {
    fail(
      "MIN_TRADE_QUANTITY_MUST_BE_GT_ZERO",
      "minTradeQuantity",
      "minTradeQuantity must be greater than zero",
    );
  }
  if (!gear.greaterThan(0)) {
    fail(
      "GEAR_AMPLITUDE_MUST_BE_GT_ZERO",
      "gearAmplitude",
      "gearAmplitude must be greater than zero",
    );
  }
  if (gear.greaterThan(100)) {
    fail(
      "GEAR_AMPLITUDE_OUT_OF_RANGE",
      "gearAmplitude",
      "gearAmplitude cannot exceed 100",
    );
  }
  if (!budget.greaterThan(0)) {
    fail("PER_SHARE_MUST_BE_GT_ZERO", "perShare", "perShare must be greater than zero");
  }

  const keepShare = requireInteger(
    input.keepShare,
    "keepShare",
    "KEEP_SHARE_MUST_BE_INTEGER",
  );
  if (keepShare < 0) {
    fail(
      "KEEP_SHARE_MUST_BE_NON_NEGATIVE",
      "keepShare",
      "keepShare must be non-negative",
    );
  }
  const increaseAmplitude = requireInteger(
    input.increaseAmplitude,
    "increaseAmplitude",
    "INCREASE_AMPLITUDE_MUST_BE_INTEGER",
  );
  if (increaseAmplitude < 0) {
    fail(
      "INCREASE_AMPLITUDE_MUST_BE_NON_NEGATIVE",
      "increaseAmplitude",
      "increaseAmplitude must be non-negative",
    );
  }
  const maxAmplitude = requireInteger(
    input.maxAmplitude,
    "maxAmplitude",
    "MAX_AMPLITUDE_MUST_BE_INTEGER",
  );
  if (maxAmplitude < 1 || maxAmplitude > 100) {
    fail(
      "MAX_AMPLITUDE_OUT_OF_RANGE",
      "maxAmplitude",
      "maxAmplitude must be between 1 and 100",
    );
  }
  const sortOrder = requireInteger(input.sortOrder, "sortOrder", "SORT_ORDER_MUST_BE_INTEGER");
  if (typeof input.isShort !== "boolean") {
    fail("IS_SHORT_MUST_BE_BOOLEAN", "isShort", "isShort must be a boolean");
  }

  let mediumAmplitude = optionalPositiveInteger(
    input.mediumAmplitude,
    "mediumAmplitude",
    "MEDIUM_AMPLITUDE_MUST_BE_GT_ZERO",
  );
  let bigAmplitude = optionalPositiveInteger(
    input.bigAmplitude,
    "bigAmplitude",
    "BIG_AMPLITUDE_MUST_BE_GT_ZERO",
  );
  let normalizedKeepShare = keepShare;
  if (input.isShort) {
    normalizedKeepShare = 0;
    mediumAmplitude = null;
    bigAmplitude = null;
  }

  let estimatedRows = new Decimal(maxAmplitude).div(gear).floor().add(1);
  if (!input.isShort && mediumAmplitude !== null) {
    estimatedRows = estimatedRows.add(Math.floor(maxAmplitude / mediumAmplitude));
  }
  if (!input.isShort && bigAmplitude !== null) {
    estimatedRows = estimatedRows.add(Math.floor(maxAmplitude / bigAmplitude));
  }
  if (estimatedRows.greaterThan(10_000)) {
    fail(
      "GRID_SIZE_LIMIT_EXCEEDED",
      "gearAmplitude",
      "Calculated grid cannot exceed 10000 rows",
    );
  }

  return {
    productName: normalizedOptionalText(input.productName, "productName"),
    productCode,
    maxPrice: maxPrice.toString(),
    minTradeQuantity: minimum.toString(),
    gearAmplitude: gear.toString(),
    perShare: budget.toString(),
    keepShare: normalizedKeepShare,
    increaseAmplitude,
    mediumAmplitude,
    bigAmplitude,
    maxAmplitude,
    isShort: input.isShort,
    category: normalizedOptionalText(input.category, "category"),
    sortOrder,
    algorithmVersion: "android-v2.1.0",
  };
}
