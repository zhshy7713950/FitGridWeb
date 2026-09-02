import { requestJson } from "@/lib/api-client";
import { isUiDemoMode } from "@/lib/ui-demo";

import type { GridTradeDetail, GridTradeMutationInput, GridTradePage } from "./types";

type DemoGridData = typeof import("./demo-grid-data");

const loadDemoGridData = process.env.NODE_ENV === "production"
  ? null
  : () => import("./demo-grid-data");

function demoGridData(): Promise<DemoGridData> {
  if (!loadDemoGridData) {
    return Promise.reject(new Error("UI demo data is unavailable in production"));
  }
  return loadDemoGridData();
}

export function listGridTrades(
  { q, cursor, signal }: { q?: string; cursor?: string; signal?: AbortSignal } = {},
): Promise<GridTradePage> {
  if (isUiDemoMode()) {
    return demoGridData().then((demo) => demo.listDemoGridTrades({ q, cursor }));
  }

  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (cursor) params.set("cursor", cursor);
  params.set("limit", "20");

  return requestJson<GridTradePage>(`/grid-trades?${params}` as `/${string}`, { signal });
}

export function getGridTrade(id: string, signal?: AbortSignal) {
  if (isUiDemoMode()) {
    return demoGridData().then((demo) => demo.getDemoGridTrade(id));
  }

  return requestJson<GridTradeDetail>(`/grid-trades/${id}`, { signal });
}

export function createGridTrade(input: GridTradeMutationInput) {
  if (isUiDemoMode()) {
    return demoGridData().then((demo) => demo.createDemoGridTrade(input));
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
    return demoGridData().then((demo) => demo.updateDemoGridTrade(id, input));
  }

  return requestJson<GridTradeDetail>(`/grid-trades/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function deleteGridTrade(id: string) {
  if (isUiDemoMode()) {
    return demoGridData().then((demo) => demo.deleteDemoGridTrade(id));
  }

  return requestJson<void>(`/grid-trades/${id}`, { method: "DELETE" });
}

export function recalculateGridTrade(id: string) {
  if (isUiDemoMode()) {
    return demoGridData().then((demo) => demo.recalculateDemoGridTrade(id));
  }

  return requestJson<GridTradeDetail>(`/grid-trades/${id}/recalculate`, { method: "POST" });
}
