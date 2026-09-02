import { requestJson } from "@/lib/api-client";
import { isUiDemoMode } from "@/lib/ui-demo";

import { listDemoGridTrades } from "./demo-grid-data";
import type { GridTradeDetail, GridTradeMutationInput, GridTradePage } from "./types";

export function listGridTrades(
  { q, cursor, signal }: { q?: string; cursor?: string; signal?: AbortSignal } = {},
): Promise<GridTradePage> {
  if (isUiDemoMode()) {
    return Promise.resolve(listDemoGridTrades({ q, cursor }));
  }

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "20");

  return requestJson<GridTradePage>(`/grid-trades?${params}` as `/${string}`, { signal });
}

export function getGridTrade(id: string, signal?: AbortSignal) {
  return requestJson<GridTradeDetail>(`/grid-trades/${id}`, { signal });
}

export function createGridTrade(input: GridTradeMutationInput) {
  return requestJson<GridTradeDetail>("/grid-trades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function updateGridTrade(
  id: string,
  input: GridTradeMutationInput & { expectedUpdatedAt: string },
) {
  return requestJson<GridTradeDetail>(`/grid-trades/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deleteGridTrade(id: string) {
  return requestJson<void>(`/grid-trades/${id}`, { method: "DELETE" });
}

export function recalculateGridTrade(id: string) {
  return requestJson<GridTradeDetail>(`/grid-trades/${id}/recalculate`, { method: "POST" });
}
