import { describe, expect, it } from "vitest";

import fixture from "../../../docs/fit-replication/fixtures/grid-algorithm-v2.1.0.json";
import { calculateGrid } from "@/server/grid-domain/calculate-grid";
import type { GridTradeInput } from "@/server/grid-domain/types";

type AndroidGridItem = (typeof fixture.cases)[number]["androidResult"]["gridItems"][number];

function decimal(value: number): string {
  return String(value);
}

function toInput(android: (typeof fixture.cases)[number]["androidResult"]): GridTradeInput {
  return {
    productName: android.productName,
    productCode: android.productCode,
    maxPrice: decimal(android.maxPrice),
    minTradeQuantity: decimal(android.minTradeQuantity),
    gearAmplitude: decimal(android.gearAmplitude),
    perShare: decimal(android.perShare),
    keepShare: android.keepShare,
    increaseAmplitude: android.increaseAmplitude,
    mediumAmplitude: android.mediumAmplitude,
    bigAmplitude: android.bigAmplitude,
    maxAmplitude: android.maxAmplitude,
    isShort: android.isShort,
    category: android.category || null,
    sortOrder: android.sortOrder,
    algorithmVersion: "android-v2.1.0",
  };
}

function expectedItem(item: AndroidGridItem) {
  return {
    sequence: item.sequence,
    gridType: item.gridType,
    gear: decimal(item.gear),
    buyPrice: decimal(item.buyPrice),
    buyCount: decimal(item.buyCount),
    buyAmount: decimal(item.buyAmount),
    sellPrice: decimal(item.sellPrice),
    sellCount: decimal(item.sellCount),
    sellAmount: decimal(item.sellAmount),
    profitAmount: decimal(item.profitAmount),
    profitRate: decimal(item.profitRate),
    keepProfit: decimal(item.keepProfit),
    keepCount: decimal(item.keepCount),
  };
}

describe("calculateGrid android-v2.1.0", () => {
  for (const testCase of fixture.cases) {
    it(`matches every characterized field for ${testCase.id}`, () => {
      const result = calculateGrid(toInput(testCase.androidResult));

      expect(result).toEqual({
        items: testCase.androidResult.gridItems.map(expectedItem),
        totalBuyAmount: decimal(testCase.androidResult.totalBuyAmount),
        totalProfitAmount: decimal(testCase.androidResult.totalProfitAmount),
        totalProfitRate: decimal(testCase.androidResult.totalProfitRate),
      });
    });
  }

  it("rejects an unknown persisted algorithm version", () => {
    const input = {
      ...toInput(fixture.cases[0].androidResult),
      algorithmVersion: "future-v1",
    } as unknown as GridTradeInput;

    expect(() => calculateGrid(input)).toThrowError(
      expect.objectContaining({ code: "ALGORITHM_VERSION_UNSUPPORTED" }),
    );
  });
});
