import { describe, expect, it } from "vitest";

import { JsonNumber, parseStrictJsonBytes } from "@/server/import-export/strict-json";

describe("strict JSON parser", () => {
  it("preserves number source text instead of rounding through JavaScript number", () => {
    const parsed = parseStrictJsonBytes(Buffer.from('{"value":0.1234567890123456789}')) as {
      value: JsonNumber;
    };
    expect(parsed.value.raw).toBe("0.1234567890123456789");
  });

  it("rejects duplicate keys and malformed UTF-8", () => {
    expect(() => parseStrictJsonBytes(Buffer.from('{"a":1,"a":2}'))).toThrowError(
      expect.objectContaining({ code: "JSON_DUPLICATE_KEY" }),
    );
    expect(() => parseStrictJsonBytes(Uint8Array.from([0xc3, 0x28]))).toThrowError(
      expect.objectContaining({ code: "JSON_UTF8_INVALID" }),
    );
  });

  it("rejects files over 10 MiB", () => {
    expect(() => parseStrictJsonBytes(new Uint8Array(10 * 1024 * 1024 + 1))).toThrowError(
      expect.objectContaining({ status: 413, code: "IMPORT_FILE_TOO_LARGE" }),
    );
  });
});
