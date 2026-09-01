import { describe, expect, it } from "vitest";

import { normalizeImportDocument } from "@/server/import-export/android-normalizer";
import { parseStrictJsonBytes } from "@/server/import-export/strict-json";

describe("Android import normalization", () => {
  it("fills v2 defaults, trims text, and ignores derived fields", () => {
    const parsed = parseStrictJsonBytes(
      Buffer.from(
        JSON.stringify([
          {
            productName: "  Demo  ",
            productCode: "  CODE  ",
            maxPrice: 1,
            perShare: 2000,
            gearAmplitude: 5,
            maxAmplitude: 60,
            totalBuyAmount: 1,
            gridItems: [],
          },
        ]),
      ),
    );
    const [item] = normalizeImportDocument(parsed);
    expect(item.input).toMatchObject({
      productName: "Demo",
      productCode: "CODE",
      minTradeQuantity: "100",
      keepShare: 0,
      increaseAmplitude: 0,
      isShort: false,
      sortOrder: 0,
      algorithmVersion: "android-v2.1.0",
    });
    expect(item.warnings).toContain("已忽略并重算 Android 派生字段");
  });

  it("marks duplicate product codes and invalid algorithm inputs", () => {
    const record = {
      productCode: "DUP",
      maxPrice: 1,
      perShare: 2000,
      gearAmplitude: 0,
      maxAmplitude: 60,
    };
    const normalized = normalizeImportDocument(
      parseStrictJsonBytes(Buffer.from(JSON.stringify([record, { ...record, gearAmplitude: 5 }]))),
    );
    expect(normalized[0].fieldErrors).toHaveProperty("gearAmplitude");
    expect(normalized[1].fieldErrors).toHaveProperty("productCode");
  });

  it("rejects more than 5000 products", () => {
    expect(() => normalizeImportDocument(new Array(5001).fill({}))).toThrowError(
      expect.objectContaining({ code: "IMPORT_ITEM_LIMIT_EXCEEDED" }),
    );
  });
});
