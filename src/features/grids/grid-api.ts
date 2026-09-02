import { requestJson } from "@/lib/api-client";
import { isUiDemoMode } from "@/lib/ui-demo";

import { listDemoGridTrades } from "./demo-grid-data";
import type { GridTradePage } from "./types";

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
