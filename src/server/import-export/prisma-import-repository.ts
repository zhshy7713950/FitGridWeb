import {
  AlgorithmVersion,
  Prisma,
  type PrismaClient,
} from "@/generated/prisma/client";
import type { GridTradeInput } from "@/server/grid-domain/types";

import type { ImportPreviewPayload, ImportRepository } from "./import-service";

function gridData(ownerId: string, input: GridTradeInput): Prisma.GridTradeUncheckedCreateInput {
  return {
    ownerId,
    productName: input.productName,
    productCode: input.productCode,
    maxPrice: input.maxPrice,
    minTradeQuantity: input.minTradeQuantity,
    gearAmplitude: input.gearAmplitude,
    perShare: input.perShare,
    keepShare: input.keepShare,
    increaseAmplitude: input.increaseAmplitude,
    mediumAmplitude: input.mediumAmplitude,
    bigAmplitude: input.bigAmplitude,
    maxAmplitude: input.maxAmplitude,
    isShort: input.isShort,
    category: input.category,
    sortOrder: input.sortOrder,
    algorithmVersion: AlgorithmVersion.ANDROID_V2_1_0,
  };
}

export class PrismaImportRepository implements ImportRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async existingCodes(ownerId: string, codes: string[]): Promise<Set<string>> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      const rows = await transaction.gridTrade.findMany({
        where: { productCode: { in: codes } },
        select: { productCode: true },
      });
      return new Set(rows.map((row) => row.productCode));
    });
  }

  async savePreview(
    ownerId: string,
    tokenDigest: string,
    fileDigest: string,
    payload: ImportPreviewPayload,
    expiresAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      await transaction.importPreview.create({
        data: {
          ownerId,
          tokenDigest,
          fileDigest,
          payload: payload as unknown as Prisma.InputJsonValue,
          expiresAt,
        },
      });
    });
  }

  async commit(
    ownerId: string,
    tokenDigest: string,
    policy: "skip" | "overwrite",
    now: Date,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      const preview = await transaction.importPreview.findFirst({
        where: { tokenDigest, consumedAt: null, expiresAt: { gt: now } },
      });
      if (!preview) return null;
      const payload = preview.payload as unknown as ImportPreviewPayload;
      let created = 0;
      let overwritten = 0;
      let skipped = 0;
      for (const item of payload.valid) {
        const existing = await transaction.gridTrade.findFirst({
          where: { productCode: item.input.productCode },
          select: { id: true },
        });
        if (!existing) {
          await transaction.gridTrade.create({ data: gridData(ownerId, item.input) });
          created += 1;
        } else if (policy === "skip") {
          skipped += 1;
        } else {
          await transaction.gridTrade.update({
            where: { id: existing.id },
            data: gridData(ownerId, item.input),
          });
          overwritten += 1;
        }
      }
      const consumed = await transaction.importPreview.updateMany({
        where: { id: preview.id, consumedAt: null },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) throw new Error("IMPORT_PREVIEW_CONCURRENTLY_CONSUMED");
      return { created, overwritten, skipped, invalid: payload.invalidCount };
    });
  }
}
