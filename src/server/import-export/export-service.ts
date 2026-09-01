import { createHmac } from "node:crypto";

import { calculateGrid } from "@/server/grid-domain/calculate-grid";
import type { GridItemResult } from "@/server/grid-domain/types";
import type { OwnerScope } from "@/server/grid-application/grid-service";
import type { GridTradeRecord } from "@/server/grid-persistence/types";

function numericItem(item: GridItemResult) {
  return {
    sequence: item.sequence,
    gridType: item.gridType,
    gear: Number(item.gear),
    buyPrice: Number(item.buyPrice),
    buyCount: Number(item.buyCount),
    buyAmount: Number(item.buyAmount),
    sellPrice: Number(item.sellPrice),
    sellCount: Number(item.sellCount),
    sellAmount: Number(item.sellAmount),
    profitAmount: Number(item.profitAmount),
    profitRate: Number(item.profitRate),
    keepProfit: Number(item.keepProfit),
    keepCount: Number(item.keepCount),
  };
}

function input(record: GridTradeRecord) {
  return {
    productName: record.productName,
    productCode: record.productCode,
    maxPrice: record.maxPrice,
    minTradeQuantity: record.minTradeQuantity,
    gearAmplitude: record.gearAmplitude,
    perShare: record.perShare,
    keepShare: record.keepShare,
    increaseAmplitude: record.increaseAmplitude,
    mediumAmplitude: record.mediumAmplitude,
    bigAmplitude: record.bigAmplitude,
    maxAmplitude: record.maxAmplitude,
    isShort: record.isShort,
    category: record.category,
    sortOrder: record.sortOrder,
    algorithmVersion: record.algorithmVersion,
  };
}

export class ExportService {
  constructor(
    private readonly withOwnerScope: OwnerScope,
    private readonly ownerRefSecret: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (ownerRefSecret.length < 32) throw new Error("OWNER_REF_SECRET must contain at least 32 characters");
  }

  async android(ownerId: string) {
    return this.withOwnerScope(ownerId, async (store) => {
      const records = await store.all();
      return records.map((record) => {
        const calculation = calculateGrid(input(record));
        return {
          productName: record.productName,
          productCode: record.productCode,
          maxPrice: Number(record.maxPrice),
          perShare: Number(record.perShare),
          gearAmplitude: Number(record.gearAmplitude),
          keepShare: record.keepShare,
          increaseAmplitude: record.increaseAmplitude,
          mediumAmplitude: record.mediumAmplitude,
          bigAmplitude: record.bigAmplitude,
          maxAmplitude: record.maxAmplitude,
          minTradeQuantity: Number(record.minTradeQuantity),
          category: record.category,
          sortOrder: record.sortOrder,
          totalBuyAmount: Number(calculation.totalBuyAmount),
          totalProfitAmount: Number(calculation.totalProfitAmount),
          totalProfitRate: Number(calculation.totalProfitRate),
          gridItems: calculation.items.map(numericItem),
          isShort: record.isShort,
        };
      });
    });
  }

  async web(ownerId: string) {
    return this.withOwnerScope(ownerId, async (store) => ({
      format: "fitgridweb-backup" as const,
      formatVersion: "1.0.0" as const,
      exportedAt: this.clock().toISOString(),
      ownerRef: `hmac-sha256:${createHmac("sha256", this.ownerRefSecret).update(ownerId).digest("hex")}`,
      products: (await store.all()).map((record) => ({
        exportId: record.id,
        ...input(record),
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
      })),
    }));
  }
}
