import { describe, expect, it } from "vitest";

import { normalizeImportDocument } from "@/server/import-export/android-normalizer";
import { parseStrictJsonBytes } from "@/server/import-export/strict-json";

import sanitizedAndroidImport from "./fixtures/android-import-sanitized.json";

describe("Android import normalization", () => {
  it("accepts the fully fictionalized 18-key Android shape and ignores its derived row", () => {
    expect(Object.keys(sanitizedAndroidImport[0])).toEqual([
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
    expect(sanitizedAndroidImport[0].gridItems).toHaveLength(1);

    const [item] = normalizeImportDocument(
      parseStrictJsonBytes(Buffer.from(JSON.stringify(sanitizedAndroidImport))),
    );

    expect(item).toMatchObject({
      index: 0,
      productCode: "SYNTH-AURORA-9173",
      input: { productCode: "SYNTH-AURORA-9173" },
    });
    expect(item.fieldErrors).toBeUndefined();
    expect(item.warnings).toContain("已忽略并重算 Android 派生字段");
  });

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

  it.each([
    [{ ownerId: "attacker" }],
    [{ ownerId: "attacker", exportId: "00000000-0000-4000-8000-000000000000", algorithmVersion: "android-v2.1.0" }],
  ])("rejects owner identity from Android and Web import records", (identityFields) => {
    const parsed = parseStrictJsonBytes(Buffer.from(JSON.stringify([{
      productCode: "OWNED",
      maxPrice: 1,
      perShare: 2000,
      gearAmplitude: 5,
      maxAmplitude: 60,
      ...identityFields,
    }])));
    expect(normalizeImportDocument(parsed)[0].fieldErrors).toHaveProperty("record");
  });
});
