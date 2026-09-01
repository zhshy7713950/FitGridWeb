import Decimal from "decimal.js";

import { GridDomainError } from "@/server/grid-domain/errors";
import type { GridTradeInput } from "@/server/grid-domain/types";
import { validateGridInput } from "@/server/grid-domain/validation";
import { ApiError } from "@/server/http/api-error";

import { JsonNumber } from "./strict-json";

export interface NormalizedImportItem {
  index: number;
  productCode: string;
  input?: GridTradeInput;
  warnings: string[];
  fieldErrors?: Record<string, string[]>;
}

const ANDROID_FIELDS = new Set([
  "productName",
  "productCode",
  "maxPrice",
  "perShare",
  "gearAmplitude",
  "keepShare",
  "increaseAmplitude",
  "mediumAmplitude",
  "bigAmplitude",
  "maxAmplitude",
  "minTradeQuantity",
  "category",
  "sortOrder",
  "totalBuyAmount",
  "totalProfitAmount",
  "totalProfitRate",
  "gridItems",
  "isShort",
]);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "IMPORT_RECORD_INVALID", "导入记录必须是对象");
  }
  return value as Record<string, unknown>;
}

function decimalText(value: unknown, field: string): string {
  if (value instanceof JsonNumber) return value.raw;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return value;
  throw new GridDomainError("DECIMAL_FORMAT_INVALID", `${field} 必须是有限数字`, field as never);
}

function integer(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  const decimal = new Decimal(decimalText(value, field));
  if (!decimal.isInteger() || decimal.abs().greaterThan(Number.MAX_SAFE_INTEGER)) {
    throw new GridDomainError(`${field.toUpperCase()}_MUST_BE_INTEGER`, `${field} 必须是整数`, field as never);
  }
  return decimal.toNumber();
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === undefined || value === null ? null : integer(value, 0, field);
}

function nullableText(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function androidRecords(document: unknown): unknown[] {
  if (Array.isArray(document)) return document;
  const envelope = object(document);
  if (envelope.format !== "fitgridweb-backup" || envelope.formatVersion !== "1.0.0") {
    throw new ApiError(422, "IMPORT_FORMAT_UNSUPPORTED", "不支持的导入格式");
  }
  if (!Array.isArray(envelope.products)) {
    throw new ApiError(422, "IMPORT_FORMAT_INVALID", "Web 备份缺少 products 数组");
  }
  return envelope.products;
}

export function normalizeImportDocument(document: unknown): NormalizedImportItem[] {
  const records = androidRecords(document);
  if (records.length > 5_000) {
    throw new ApiError(422, "IMPORT_ITEM_LIMIT_EXCEEDED", "导入产品不能超过 5000 条");
  }
  const codeCounts = new Map<string, number>();
  for (const raw of records) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const code = (raw as Record<string, unknown>).productCode;
      if (typeof code === "string" && code.trim()) {
        const normalized = code.trim();
        codeCounts.set(normalized, (codeCounts.get(normalized) ?? 0) + 1);
      }
    }
  }
  return records.map((raw, index) => {
    let productCode = "";
    const warnings: string[] = [];
    try {
      const source = object(raw);
      const isWeb = "algorithmVersion" in source || "exportId" in source;
      if (!isWeb) {
        const unknown = Object.keys(source).filter((key) => !ANDROID_FIELDS.has(key));
        if (unknown.length > 0) {
          throw new GridDomainError("IMPORT_UNKNOWN_FIELD", `未知字段：${unknown.join(", ")}`);
        }
      }
      productCode = typeof source.productCode === "string" ? source.productCode.trim() : "";
      const defaulted = (field: string, value: unknown, fallback: unknown) => {
        if (value === undefined || value === null) warnings.push(`已补齐历史字段 ${field}`);
        return value === undefined || value === null ? fallback : value;
      };
      if (
        "gridItems" in source ||
        "totalBuyAmount" in source ||
        "totalProfitAmount" in source ||
        "totalProfitRate" in source
      ) {
        warnings.push("已忽略并重算 Android 派生字段");
      }
      const input = validateGridInput({
        productName: nullableText(source.productName),
        productCode,
        maxPrice: decimalText(source.maxPrice, "maxPrice"),
        minTradeQuantity: decimalText(
          defaulted("minTradeQuantity", source.minTradeQuantity, new JsonNumber("100")),
          "minTradeQuantity",
        ),
        gearAmplitude: decimalText(source.gearAmplitude, "gearAmplitude"),
        perShare: decimalText(source.perShare, "perShare"),
        keepShare: integer(defaulted("keepShare", source.keepShare, 0), 0, "keepShare"),
        increaseAmplitude: integer(
          defaulted("increaseAmplitude", source.increaseAmplitude, 0),
          0,
          "increaseAmplitude",
        ),
        mediumAmplitude: nullableInteger(source.mediumAmplitude, "mediumAmplitude"),
        bigAmplitude: nullableInteger(source.bigAmplitude, "bigAmplitude"),
        maxAmplitude: integer(source.maxAmplitude, 0, "maxAmplitude"),
        isShort: Boolean(defaulted("isShort", source.isShort, false)),
        category: nullableText(defaulted("category", source.category, "")),
        sortOrder: integer(defaulted("sortOrder", source.sortOrder, index), index, "sortOrder"),
        algorithmVersion:
          source.algorithmVersion === undefined
            ? "android-v2.1.0"
            : (source.algorithmVersion as "android-v2.1.0"),
      });
      if ((codeCounts.get(input.productCode) ?? 0) > 1) {
        return {
          index,
          productCode: input.productCode,
          warnings,
          fieldErrors: { productCode: ["同一文件内产品代码重复"] },
        };
      }
      return { index, productCode: input.productCode, input, warnings };
    } catch (error) {
      if (error instanceof GridDomainError) {
        return {
          index,
          productCode,
          warnings,
          fieldErrors: { [error.field ?? "record"]: [error.message] },
        };
      }
      throw error;
    }
  });
}
