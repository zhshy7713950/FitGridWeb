import Decimal from "decimal.js";

import type { GridTradeDetail, GridTradeMutationInput } from "./types";

export interface GridFormValues {
  productName: string;
  productCode: string;
  maxPrice: string;
  minTradeQuantity: string;
  gearAmplitude: string;
  perShare: string;
  keepShare: string;
  increaseAmplitude: string;
  mediumAmplitude: string;
  bigAmplitude: string;
  maxAmplitude: string;
  isShort: boolean;
  category: string;
  sortOrder: string;
}

export const defaultGridFormValues: GridFormValues = {
  productName: "",
  productCode: "",
  maxPrice: "1",
  minTradeQuantity: "100",
  gearAmplitude: "5",
  perShare: "2000",
  keepShare: "2",
  increaseAmplitude: "5",
  mediumAmplitude: "15",
  bigAmplitude: "30",
  maxAmplitude: "60",
  isShort: false,
  category: "",
  sortOrder: "0",
};

export interface GridFormValidationResult {
  input?: GridTradeMutationInput;
  fieldErrors: Record<string, string[]>;
}

// Keep this deliberately broader than the server's persistence grammar. The browser
// accepts ordinary human decimal input; the server remains the authoritative parser.
const DECIMAL_PATTERN = /^(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))$/;
const INTEGER_PATTERN = /^-?[0-9]+$/;

function addError(fieldErrors: Record<string, string[]>, field: string, message: string) {
  (fieldErrors[field] ??= []).push(message);
}

function parseDecimal(
  value: string,
  field: string,
  label: string,
  fieldErrors: Record<string, string[]>,
): { text: string; number: Decimal } | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    addError(fieldErrors, field, `${label}不能为空`);
    return undefined;
  }
  if (!DECIMAL_PATTERN.test(text)) {
    addError(fieldErrors, field, `${label}必须是有效的十进制数字`);
    return undefined;
  }

  try {
    const number = new Decimal(text);
    if (!number.isFinite()) {
      addError(fieldErrors, field, `${label}必须是有效的十进制数字`);
      return undefined;
    }
    return { text: number.toFixed(), number };
  } catch {
    addError(fieldErrors, field, `${label}必须是有效的十进制数字`);
    return undefined;
  }
}

function parseInteger(
  value: string,
  field: string,
  message: string,
  fieldErrors: Record<string, string[]>,
  allowBlank = false,
): number | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text && allowBlank) return 0;
  if (!INTEGER_PATTERN.test(text)) {
    addError(fieldErrors, field, message);
    return undefined;
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    addError(fieldErrors, field, message);
    return undefined;
  }
  return number;
}

function optionalPositiveInteger(
  value: string,
  field: string,
  label: string,
  fieldErrors: Record<string, string[]>,
): number | null | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const number = parseInteger(
    text,
    field,
    `${label}必须是正整数`,
    fieldErrors,
  );
  if (number === undefined) return undefined;
  if (number <= 0) {
    addError(fieldErrors, field, `${label}必须是正整数`);
    return undefined;
  }
  return number;
}

function nullableText(
  value: string,
  field: string,
  label: string,
  fieldErrors: Record<string, string[]>,
): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > 120) {
    addError(fieldErrors, field, `${label}不能超过 120 个字符`);
  }
  return text || null;
}

export function detailToFormValues(detail: GridTradeDetail): GridFormValues {
  const input = detail.input;
  return {
    productName: input.productName ?? "",
    productCode: input.productCode,
    maxPrice: input.maxPrice,
    minTradeQuantity: input.minTradeQuantity,
    gearAmplitude: input.gearAmplitude,
    perShare: input.perShare,
    keepShare: String(input.keepShare),
    increaseAmplitude: String(input.increaseAmplitude),
    mediumAmplitude: input.mediumAmplitude === null ? "" : String(input.mediumAmplitude),
    bigAmplitude: input.bigAmplitude === null ? "" : String(input.bigAmplitude),
    maxAmplitude: String(input.maxAmplitude),
    isShort: input.isShort,
    category: input.category ?? "",
    sortOrder: String(input.sortOrder),
  };
}

export function validateGridForm(values: GridFormValues): GridFormValidationResult {
  const fieldErrors: Record<string, string[]> = {};
  const productName = nullableText(values.productName, "productName", "产品名称", fieldErrors);
  const category = nullableText(values.category, "category", "分类", fieldErrors);

  const productCode = typeof values.productCode === "string" ? values.productCode.trim() : "";
  if (!productCode) {
    addError(fieldErrors, "productCode", "产品代码不能为空");
  } else if (productCode.length > 64) {
    addError(fieldErrors, "productCode", "产品代码不能超过 64 个字符");
  }

  const maxPrice = parseDecimal(values.maxPrice, "maxPrice", "最高价格", fieldErrors);
  const minTradeQuantity = parseDecimal(
    values.minTradeQuantity,
    "minTradeQuantity",
    "最小交易数量",
    fieldErrors,
  );
  const gearAmplitude = parseDecimal(
    values.gearAmplitude,
    "gearAmplitude",
    "档位幅度",
    fieldErrors,
  );
  const perShare = parseDecimal(values.perShare, "perShare", "每份金额", fieldErrors);

  if (maxPrice && !maxPrice.number.greaterThan(0)) {
    addError(fieldErrors, "maxPrice", "最高价格必须大于 0");
  }
  if (minTradeQuantity && !minTradeQuantity.number.greaterThan(0)) {
    addError(fieldErrors, "minTradeQuantity", "最小交易数量必须大于 0");
  }
  if (gearAmplitude) {
    if (!gearAmplitude.number.greaterThan(0) || gearAmplitude.number.greaterThan(100)) {
      addError(fieldErrors, "gearAmplitude", "档位幅度必须大于 0 且不超过 100");
    }
  }
  if (perShare && !perShare.number.greaterThan(0)) {
    addError(fieldErrors, "perShare", "每份金额必须大于 0");
  }

  const maxAmplitude = parseInteger(
    values.maxAmplitude,
    "maxAmplitude",
    "最大振幅必须是整数",
    fieldErrors,
  );
  if (maxAmplitude !== undefined && (maxAmplitude < 1 || maxAmplitude > 100)) {
    addError(fieldErrors, "maxAmplitude", "最大振幅必须介于 1 和 100 之间");
  }

  const isShort = values.isShort === true;
  const keepShare = isShort
    ? 0
    : parseInteger(
        values.keepShare,
        "keepShare",
        "留存份数必须为非负整数",
        fieldErrors,
        true,
      );
  if (!isShort && keepShare !== undefined && keepShare < 0) {
    addError(fieldErrors, "keepShare", "留存份数必须为非负整数");
  }

  const increaseAmplitude = parseInteger(
    values.increaseAmplitude,
    "increaseAmplitude",
    "加码幅度必须为非负整数",
    fieldErrors,
    true,
  );
  if (increaseAmplitude !== undefined && increaseAmplitude < 0) {
    addError(fieldErrors, "increaseAmplitude", "加码幅度必须为非负整数");
  }

  const mediumAmplitude = isShort
    ? null
    : optionalPositiveInteger(values.mediumAmplitude, "mediumAmplitude", "中网幅度", fieldErrors);
  const bigAmplitude = isShort
    ? null
    : optionalPositiveInteger(values.bigAmplitude, "bigAmplitude", "大网幅度", fieldErrors);
  const sortOrder = parseInteger(
    values.sortOrder,
    "sortOrder",
    "排序必须为整数",
    fieldErrors,
    true,
  );

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  return {
    input: {
      productName,
      productCode,
      maxPrice: maxPrice!.text,
      minTradeQuantity: minTradeQuantity!.text,
      gearAmplitude: gearAmplitude!.text,
      perShare: perShare!.text,
      keepShare: keepShare!,
      increaseAmplitude: increaseAmplitude!,
      mediumAmplitude: mediumAmplitude!,
      bigAmplitude: bigAmplitude!,
      maxAmplitude: maxAmplitude!,
      isShort,
      category,
      sortOrder: sortOrder!,
    },
    fieldErrors,
  };
}
