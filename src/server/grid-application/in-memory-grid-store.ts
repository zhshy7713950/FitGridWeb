import { randomUUID } from "node:crypto";

import { ApiError } from "@/server/http/api-error";
import type {
  GridTradeListQuery,
  GridTradePage,
  GridTradeRecord,
  GridTradeUpdateResult,
  OwnerScopedGridTradeStore,
} from "@/server/grid-persistence/types";

interface OwnedRecord extends GridTradeRecord {
  ownerId: string;
}

function clone(record: OwnedRecord): GridTradeRecord {
  const copy: Partial<OwnedRecord> = { ...record };
  delete copy.ownerId;
  return copy as GridTradeRecord;
}

export class InMemoryGridDatabase {
  private readonly records = new Map<string, OwnedRecord>();
  private now: Date;

  constructor(initialTime = new Date()) {
    this.now = new Date(initialTime);
  }

  advanceClock(milliseconds: number): void {
    this.now = new Date(this.now.valueOf() + milliseconds);
  }

  readonly scope = async <T>(
    ownerId: string,
    fn: (store: OwnerScopedGridTradeStore) => Promise<T>,
  ): Promise<T> => fn(this.store(ownerId));

  private store(ownerId: string): OwnerScopedGridTradeStore {
    const owned = () => [...this.records.values()].filter((item) => item.ownerId === ownerId);
    return {
      list: async (query: GridTradeListQuery): Promise<GridTradePage> => {
        const sorted = owned()
          .filter((item) => {
            const q = query.q?.trim().toLowerCase();
            return (
              !q ||
              item.productCode.toLowerCase().includes(q) ||
              item.productName?.toLowerCase().includes(q)
            );
          })
          .sort(
            (left, right) =>
              left.sortOrder - right.sortOrder ||
              left.createdAt.valueOf() - right.createdAt.valueOf() ||
              left.id.localeCompare(right.id),
          );
        let start = 0;
        if (query.cursor) {
          let cursor: { ownerId: string; id: string };
          try {
            cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")) as {
              ownerId: string;
              id: string;
            };
          } catch {
            throw new ApiError(400, "SIGNED_TOKEN_INVALID", "分页游标无效");
          }
          if (cursor.ownerId !== ownerId) {
            throw new ApiError(400, "SIGNED_TOKEN_INVALID", "分页游标无效");
          }
          const index = sorted.findIndex((item) => item.id === cursor.id);
          if (index < 0) throw new ApiError(400, "SIGNED_TOKEN_INVALID", "分页游标无效");
          start = index + 1;
        }
        const items = sorted.slice(start, start + query.limit);
        const last = items.at(-1);
        const hasMore = start + items.length < sorted.length;
        return {
          items: items.map(clone),
          nextCursor:
            hasMore && last
              ? Buffer.from(JSON.stringify({ ownerId, id: last.id }), "utf8").toString("base64url")
              : null,
        };
      },
      findById: async (id) => {
        const found = this.records.get(id);
        return found?.ownerId === ownerId ? clone(found) : null;
      },
      findByProductCode: async (code) => {
        const found = owned().find((item) => item.productCode === code);
        return found ? clone(found) : null;
      },
      create: async (input) => {
        const createdAt = new Date(this.now);
        const created: OwnedRecord = {
          ...input,
          id: randomUUID(),
          ownerId,
          createdAt,
          updatedAt: createdAt,
        };
        this.records.set(created.id, created);
        this.advanceClock(1);
        return clone(created);
      },
      update: async (id, input, expectedUpdatedAt): Promise<GridTradeUpdateResult> => {
        const existing = this.records.get(id);
        if (!existing || existing.ownerId !== ownerId) return { kind: "not_found" };
        if (existing.updatedAt.valueOf() !== expectedUpdatedAt.valueOf()) return { kind: "conflict" };
        const updated: OwnedRecord = {
          ...existing,
          ...input,
          ownerId,
          id,
          createdAt: existing.createdAt,
          updatedAt: new Date(this.now),
        };
        this.records.set(id, updated);
        this.advanceClock(1);
        return { kind: "updated", record: clone(updated) };
      },
      delete: async (id) => {
        const existing = this.records.get(id);
        return existing?.ownerId === ownerId ? this.records.delete(id) : false;
      },
      all: async () => owned().map(clone),
    };
  }
}
