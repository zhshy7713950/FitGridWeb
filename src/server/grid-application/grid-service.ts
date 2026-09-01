import { calculateGrid } from "@/server/grid-domain/calculate-grid";
import { validateGridInput } from "@/server/grid-domain/validation";
import type { GridTradeInput } from "@/server/grid-domain/types";
import { ApiError } from "@/server/http/api-error";
import type {
  GridTradeListQuery,
  GridTradeRecord,
  OwnerScopedGridTradeStore,
} from "@/server/grid-persistence/types";

import { parseGridCreate, parseGridUpdate } from "./dto";

export type OwnerScope = <T>(
  ownerId: string,
  fn: (store: OwnerScopedGridTradeStore) => Promise<T>,
) => Promise<T>;

function notFound(): ApiError {
  return new ApiError(404, "GRID_TRADE_NOT_FOUND", "网格产品不存在");
}

function summary(record: GridTradeRecord) {
  return {
    id: record.id,
    productName: record.productName,
    productCode: record.productCode,
    maxPrice: record.maxPrice,
    perShare: record.perShare,
    isShort: record.isShort,
    algorithmVersion: record.algorithmVersion,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function storedInput(record: GridTradeRecord): GridTradeInput {
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

function detail(record: GridTradeRecord) {
  const input = storedInput(record);
  return {
    ...summary(record),
    input,
    calculation: calculateGrid(input),
  };
}

export class GridService {
  constructor(private readonly withOwnerScope: OwnerScope) {}

  async list(ownerId: string, query: Partial<GridTradeListQuery> = {}) {
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(422, "LIMIT_OUT_OF_RANGE", "limit 必须介于 1 和 100 之间");
    }
    return this.withOwnerScope(ownerId, async (store) => {
      const page = await store.list({ q: query.q, cursor: query.cursor, limit });
      return { items: page.items.map(summary), nextCursor: page.nextCursor };
    });
  }

  async get(ownerId: string, id: string) {
    return this.withOwnerScope(ownerId, async (store) => {
      const found = await store.findById(id);
      if (!found) throw notFound();
      return detail(found);
    });
  }

  async create(ownerId: string, body: unknown) {
    const input = parseGridCreate(body);
    return this.withOwnerScope(ownerId, async (store) => {
      if (await store.findByProductCode(input.productCode)) {
        throw new ApiError(409, "PRODUCT_CODE_CONFLICT", "产品代码已存在", {
          productCode: ["当前账号已存在相同产品代码"],
        });
      }
      return detail(await store.create(input));
    });
  }

  async update(ownerId: string, id: string, body: unknown) {
    const { expectedUpdatedAt, ...patch } = parseGridUpdate(body);
    return this.withOwnerScope(ownerId, async (store) => {
      const existing = await store.findById(id);
      if (!existing) throw notFound();
      const input = validateGridInput({ ...storedInput(existing), ...patch });
      const sameCode = await store.findByProductCode(input.productCode);
      if (sameCode && sameCode.id !== id) {
        throw new ApiError(409, "PRODUCT_CODE_CONFLICT", "产品代码已存在", {
          productCode: ["当前账号已存在相同产品代码"],
        });
      }
      const result = await store.update(id, input, new Date(expectedUpdatedAt));
      if (result.kind === "not_found") throw notFound();
      if (result.kind === "conflict") {
        throw new ApiError(409, "EDIT_CONFLICT", "产品已被其他请求更新");
      }
      return detail(result.record);
    });
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.withOwnerScope(ownerId, async (store) => {
      if (!(await store.delete(id))) throw notFound();
    });
  }

  async recalculate(ownerId: string, id: string) {
    return this.get(ownerId, id);
  }
}
