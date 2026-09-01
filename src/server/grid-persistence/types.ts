import type { GridTradeInput } from "@/server/grid-domain/types";

export interface GridTradeRecord extends GridTradeInput {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface GridTradeListQuery {
  q?: string;
  cursor?: string;
  limit: number;
}

export interface GridTradePage {
  items: GridTradeRecord[];
  nextCursor: string | null;
}

export type GridTradeUpdateResult =
  | { kind: "updated"; record: GridTradeRecord }
  | { kind: "not_found" }
  | { kind: "conflict" };

export interface OwnerScopedGridTradeStore {
  list(query: GridTradeListQuery): Promise<GridTradePage>;
  findById(id: string): Promise<GridTradeRecord | null>;
  findByProductCode(code: string): Promise<GridTradeRecord | null>;
  create(input: GridTradeInput): Promise<GridTradeRecord>;
  update(
    id: string,
    input: GridTradeInput,
    expectedUpdatedAt: Date,
  ): Promise<GridTradeUpdateResult>;
  delete(id: string): Promise<boolean>;
  all(): Promise<GridTradeRecord[]>;
}
