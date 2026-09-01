import type { PrismaClient } from "@/generated/prisma/client";
import { AlgorithmVersion, Prisma } from "@/generated/prisma/client";
import type { GridTradeInput } from "@/server/grid-domain/types";
import { ApiError } from "@/server/http/api-error";
import { signScopedToken, verifyScopedToken } from "@/server/security/signed-token";

import type {
  GridTradeListQuery,
  GridTradePage,
  GridTradeRecord,
  GridTradeUpdateResult,
  OwnerScopedGridTradeStore,
} from "./types";

interface CursorPayload {
  ownerId: string;
  sortOrder: number;
  createdAt: string;
  id: string;
  exp: number;
  [key: string]: unknown;
}

type GridRow = Awaited<ReturnType<Prisma.TransactionClient["gridTrade"]["findFirst"]>>;

function record(row: NonNullable<GridRow>): GridTradeRecord {
  return {
    id: row.id,
    productName: row.productName,
    productCode: row.productCode,
    maxPrice: row.maxPrice.toString(),
    minTradeQuantity: row.minTradeQuantity.toString(),
    gearAmplitude: row.gearAmplitude.toString(),
    perShare: row.perShare.toString(),
    keepShare: row.keepShare,
    increaseAmplitude: row.increaseAmplitude,
    mediumAmplitude: row.mediumAmplitude,
    bigAmplitude: row.bigAmplitude,
    maxAmplitude: row.maxAmplitude,
    isShort: row.isShort,
    category: row.category,
    sortOrder: row.sortOrder,
    algorithmVersion: "android-v2.1.0",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function data(ownerId: string, input: GridTradeInput): Prisma.GridTradeUncheckedCreateInput {
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

class PrismaGridTradeStore implements OwnerScopedGridTradeStore {
  constructor(
    private readonly transaction: Prisma.TransactionClient,
    private readonly ownerId: string,
    private readonly cursorSecret: string,
  ) {}

  async list(query: GridTradeListQuery): Promise<GridTradePage> {
    let after: Prisma.GridTradeWhereInput | undefined;
    if (query.cursor) {
      const cursor = verifyScopedToken<CursorPayload>(query.cursor, this.cursorSecret, {
        ownerId: this.ownerId,
      });
      const createdAt = new Date(cursor.createdAt);
      if (Number.isNaN(createdAt.valueOf())) {
        throw new ApiError(400, "SIGNED_TOKEN_INVALID", "分页游标无效");
      }
      after = {
        OR: [
          { sortOrder: { gt: cursor.sortOrder } },
          { sortOrder: cursor.sortOrder, createdAt: { gt: createdAt } },
          { sortOrder: cursor.sortOrder, createdAt, id: { gt: cursor.id } },
        ],
      };
    }
    const q = query.q?.trim();
    const rows = await this.transaction.gridTrade.findMany({
      where: {
        AND: [
          after ?? {},
          q
            ? {
                OR: [
                  { productCode: { contains: q, mode: "insensitive" } },
                  { productName: { contains: q, mode: "insensitive" } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(record),
      nextCursor:
        hasMore && last
          ? signScopedToken(
              {
                ownerId: this.ownerId,
                sortOrder: last.sortOrder,
                createdAt: last.createdAt.toISOString(),
                id: last.id,
                exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
              },
              this.cursorSecret,
            )
          : null,
    };
  }

  async findById(id: string): Promise<GridTradeRecord | null> {
    const row = await this.transaction.gridTrade.findFirst({ where: { id } });
    return row ? record(row) : null;
  }

  async findByProductCode(code: string): Promise<GridTradeRecord | null> {
    const row = await this.transaction.gridTrade.findFirst({ where: { productCode: code } });
    return row ? record(row) : null;
  }

  async create(input: GridTradeInput): Promise<GridTradeRecord> {
    return record(await this.transaction.gridTrade.create({ data: data(this.ownerId, input) }));
  }

  async update(
    id: string,
    input: GridTradeInput,
    expectedUpdatedAt: Date,
  ): Promise<GridTradeUpdateResult> {
    const existing = await this.transaction.gridTrade.findFirst({ where: { id } });
    if (!existing) return { kind: "not_found" };
    const result = await this.transaction.gridTrade.updateMany({
      where: { id, updatedAt: expectedUpdatedAt },
      data: data(this.ownerId, input),
    });
    if (result.count === 0) return { kind: "conflict" };
    const updated = await this.transaction.gridTrade.findFirstOrThrow({ where: { id } });
    return { kind: "updated", record: record(updated) };
  }

  async delete(id: string): Promise<boolean> {
    return (await this.transaction.gridTrade.deleteMany({ where: { id } })).count === 1;
  }

  async all(): Promise<GridTradeRecord[]> {
    const rows = await this.transaction.gridTrade.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    return rows.map(record);
  }
}

function cursorSecret(): string {
  const secret = process.env.CURSOR_SIGNING_SECRET ?? process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("CURSOR_SIGNING_SECRET or BETTER_AUTH_SECRET must contain at least 32 characters");
  }
  return secret;
}

export async function withOwnerScope<T>(
  ownerId: string,
  fn: (store: OwnerScopedGridTradeStore) => Promise<T>,
  prisma: PrismaClient,
  signingSecret = cursorSecret(),
): Promise<T> {
  return prisma.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
    return fn(new PrismaGridTradeStore(transaction, ownerId, signingSecret));
  });
}
