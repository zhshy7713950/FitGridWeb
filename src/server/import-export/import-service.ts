import { createHash, randomBytes } from "node:crypto";

import type { GridTradeInput } from "@/server/grid-domain/types";
import { ApiError } from "@/server/http/api-error";

import { normalizeImportDocument, type NormalizedImportItem } from "./android-normalizer";
import { parseStrictJsonBytes } from "./strict-json";

export interface ImportPreviewPayload {
  valid: Array<{ index: number; input: GridTradeInput; warnings: string[] }>;
  invalidCount: number;
}

export interface ImportRepository {
  existingCodes(ownerId: string, codes: string[]): Promise<Set<string>>;
  savePreview(
    ownerId: string,
    tokenDigest: string,
    fileDigest: string,
    payload: ImportPreviewPayload,
    expiresAt: Date,
  ): Promise<void>;
  commit(
    ownerId: string,
    tokenDigest: string,
    policy: "skip" | "overwrite",
    now: Date,
  ): Promise<{ created: number; overwritten: number; skipped: number; invalid: number } | null>;
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function previewItem(item: NormalizedImportItem) {
  return {
    index: item.index,
    productCode: item.productCode,
    ...(item.warnings.length > 0 ? { warnings: item.warnings } : {}),
    ...(item.fieldErrors ? { fieldErrors: item.fieldErrors } : {}),
  };
}

export class ImportService {
  constructor(private readonly repository: ImportRepository) {}

  async preview(ownerId: string, bytes: Uint8Array, now = new Date()) {
    const normalized = normalizeImportDocument(parseStrictJsonBytes(bytes));
    const valid = normalized.filter(
      (item): item is NormalizedImportItem & { input: GridTradeInput } => Boolean(item.input),
    );
    const conflicts = await this.repository.existingCodes(
      ownerId,
      valid.map((item) => item.input.productCode),
    );
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.valueOf() + 15 * 60 * 1000);
    await this.repository.savePreview(
      ownerId,
      digest(token),
      digest(bytes),
      {
        valid: valid.map((item) => ({ index: item.index, input: item.input, warnings: item.warnings })),
        invalidCount: normalized.length - valid.length,
      },
      expiresAt,
    );
    const creates = valid.filter((item) => !conflicts.has(item.input.productCode)).map(previewItem);
    const conflictItems = valid.filter((item) => conflicts.has(item.input.productCode)).map(previewItem);
    const invalid = normalized.filter((item) => !item.input).map(previewItem);
    return {
      previewToken: token,
      expiresAt: expiresAt.toISOString(),
      creates,
      conflicts: conflictItems,
      invalid,
      warnings: [...new Set(normalized.flatMap((item) => item.warnings))],
    };
  }

  async commit(
    ownerId: string,
    previewToken: string,
    conflictPolicy: "skip" | "overwrite",
    now = new Date(),
  ) {
    if (conflictPolicy !== "skip" && conflictPolicy !== "overwrite") {
      throw new ApiError(422, "IMPORT_CONFLICT_POLICY_INVALID", "冲突策略必须为 skip 或 overwrite");
    }
    const result = await this.repository.commit(ownerId, digest(previewToken), conflictPolicy, now);
    if (!result) {
      throw new ApiError(404, "IMPORT_PREVIEW_NOT_FOUND", "导入预检不存在、已过期或已使用");
    }
    return result;
  }
}
