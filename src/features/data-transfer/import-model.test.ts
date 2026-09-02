import { describe, expect, it } from "vitest";

import { isPreviewExpired, validateImportFile } from "./import-model";
import type { ImportPreview } from "./types";

const TEN_MIB = 10 * 1024 * 1024;

function preview(expiresAt: string): ImportPreview {
  return {
    previewToken: "synthetic-preview-token-longer-than-thirty-two-characters",
    expiresAt,
    creates: [],
    conflicts: [],
    invalid: [],
    warnings: [],
  };
}

describe("validateImportFile", () => {
  it("accepts a JSON extension case-insensitively without trusting MIME type", () => {
    expect(validateImportFile(new File(["[]"], "backup.JSON", { type: "text/plain" }))).toBeNull();
  });

  it("rejects every non-JSON filename even when its MIME type claims JSON", () => {
    expect(validateImportFile(new File(["{}"], "data.txt", { type: "application/json" }))).toBe(
      "请选择 JSON 文件",
    );
  });

  it("rejects an empty JSON file", () => {
    expect(validateImportFile(new File([], "data.json"))).toBe("导入文件不能为空");
  });

  it("allows exactly 10 MiB", () => {
    expect(validateImportFile(new File([new Uint8Array(TEN_MIB)], "data.json"))).toBeNull();
  });

  it("rejects a file one byte above 10 MiB", () => {
    expect(validateImportFile(new File([new Uint8Array(TEN_MIB + 1)], "data.json"))).toBe(
      "导入文件不能超过 10 MiB",
    );
  });
});

describe("isPreviewExpired", () => {
  const expiresAt = "2026-09-02T00:15:00.000Z";

  it("keeps a preview valid strictly before its expiry", () => {
    expect(isPreviewExpired(preview(expiresAt), new Date("2026-09-02T00:14:59.999Z"))).toBe(false);
  });

  it("treats equality and later times as expired", () => {
    expect(isPreviewExpired(preview(expiresAt), new Date(expiresAt))).toBe(true);
    expect(isPreviewExpired(preview(expiresAt), new Date("2026-09-02T00:15:00.001Z"))).toBe(true);
  });

  it("fails safe for an invalid preview timestamp or clock", () => {
    expect(isPreviewExpired(preview("not-a-timestamp"), new Date("2026-09-02T00:00:00Z"))).toBe(true);
    expect(isPreviewExpired(preview(expiresAt), new Date(Number.NaN))).toBe(true);
  });
});
