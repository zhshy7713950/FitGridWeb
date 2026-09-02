import { requestJson } from "@/lib/api-client";
import { isUiDemoMode } from "@/lib/ui-demo";

import {
  createDemoGridTrade,
  deleteDemoGridTrade,
  getDemoGridTrade,
  listDemoGridTrades,
  recalculateDemoGridTrade,
  updateDemoGridTrade,
} from "./demo-grid-data";
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
  if (isUiDemoMode()) {
    return Promise.resolve().then(() => getDemoGridTrade(id));
  }

  return requestJson<GridTradeDetail>(`/grid-trades/${id}`, { signal });
}

export function createGridTrade(input: GridTradeMutationInput) {
  if (isUiDemoMode()) {
    return Promise.resolve().then(() => createDemoGridTrade(input));
  }

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
  if (isUiDemoMode()) {
    return Promise.resolve().then(() => updateDemoGridTrade(id, input));
  }

  return requestJson<GridTradeDetail>(`/grid-trades/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deleteGridTrade(id: string) {
  if (isUiDemoMode()) {
    return Promise.resolve().then(() => deleteDemoGridTrade(id));
  }

  return requestJson<void>(`/grid-trades/${id}`, { method: "DELETE" });
}

export function recalculateGridTrade(id: string) {
  if (isUiDemoMode()) {
    return Promise.resolve().then(() => recalculateDemoGridTrade(id));
  }

  return requestJson<GridTradeDetail>(`/grid-trades/${id}/recalculate`, { method: "POST" });
}
