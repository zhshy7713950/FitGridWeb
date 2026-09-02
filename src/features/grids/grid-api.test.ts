import { afterEach, expect, it, vi } from "vitest";

import {
  createGridTrade,
  deleteGridTrade,
  getGridTrade,
  listGridTrades,
  recalculateGridTrade,
  updateGridTrade,
} from "./grid-api";
import type { GridTradeDetail, GridTradeMutationInput } from "./types";

const validInput: GridTradeMutationInput = {
  productName: "黄金 ETF",
  productCode: "518880",
  maxPrice: "800",
  minTradeQuantity: "100",
  gearAmplitude: "0.02",
  perShare: "1000",
  keepShare: 1,
  increaseAmplitude: 0.03,
  mediumAmplitude: null,
  bigAmplitude: null,
  maxAmplitude: 0.1,
  isShort: false,
  category: "ETF",
  sortOrder: 2,
};

const detail: GridTradeDetail = {
  id: "11111111-1111-4111-8111-111111111111",
  productName: "黄金 ETF",
  productCode: "518880",
  maxPrice: "800",
  perShare: "1000",
  isShort: false,
  algorithmVersion: "android-v2.1.0",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
  input: { ...validInput, algorithmVersion: "android-v2.1.0" },
  calculation: {
    items: [],
    totalBuyAmount: "0",
    totalProfitAmount: "0",
    totalProfitRate: "0",
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("encodes q, cursor, and the fixed 20-item limit", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [], nextCursor: null }));
  vi.stubGlobal("fetch", fetcher);

  await listGridTrades({ q: "黄金 ETF", cursor: "signed+cursor" });

  expect(fetcher.mock.calls[0][0]).toBe(
    "/api/v1/grid-trades?q=%E9%BB%84%E9%87%91+ETF&cursor=signed%2Bcursor&limit=20",
  );
});

it("serves searchable paginated products without a server in UI demo mode", async () => {
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
  vi.stubEnv("NODE_ENV", "development");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);

  const first = await listGridTrades();
  const second = await listGridTrades({ cursor: first.nextCursor! });
  const searched = await listGridTrades({ q: "518880" });

  expect(first.items).toHaveLength(20);
  expect(first.nextCursor).toBe("demo:20");
  expect(second.items).toHaveLength(4);
  expect(second.nextCursor).toBeNull();
  expect(searched.items.map((item) => item.productName)).toEqual(["黄金 ETF"]);
  expect(fetcher).not.toHaveBeenCalled();
});

it("loads a grid trade detail and forwards cancellation", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(detail));
  const controller = new AbortController();
  vi.stubGlobal("fetch", fetcher);

  await expect(getGridTrade(detail.id, controller.signal)).resolves.toEqual(detail);

  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/grid-trades/${detail.id}`,
    expect.objectContaining({ signal: controller.signal }),
  );
});

it("creates a grid trade with the complete browser DTO", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(detail));
  vi.stubGlobal("fetch", fetcher);

  await createGridTrade(validInput);

  expect(fetcher).toHaveBeenCalledWith(
    "/api/v1/grid-trades",
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
      body: JSON.stringify(validInput),
    }),
  );
});

it("sends the optimistic-lock timestamp when updating", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(detail));
  vi.stubGlobal("fetch", fetcher);
  const input = { ...validInput, expectedUpdatedAt: "2026-09-02T00:00:00.000Z" };

  await updateGridTrade(detail.id, input);

  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/grid-trades/${detail.id}`,
    expect.objectContaining({ method: "PATCH", body: JSON.stringify(input) }),
  );
});

it("deletes a grid trade without attempting to parse its empty response", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);

  await expect(deleteGridTrade(detail.id)).resolves.toBeUndefined();

  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/grid-trades/${detail.id}`,
    expect.objectContaining({ method: "DELETE" }),
  );
});

it("uses POST for authoritative recalculation", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(detail));
  vi.stubGlobal("fetch", fetcher);

  await expect(recalculateGridTrade(detail.id)).resolves.toEqual(detail);

  expect(fetcher).toHaveBeenCalledWith(
    `/api/v1/grid-trades/${detail.id}/recalculate`,
    expect.objectContaining({ method: "POST" }),
  );
});
