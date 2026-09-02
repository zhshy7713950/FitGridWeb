import { afterEach, expect, it, vi } from "vitest";

import {
  createGridTrade,
  deleteGridTrade,
  getGridTrade,
  listGridTrades,
  recalculateGridTrade,
  updateGridTrade,
} from "./grid-api";
import { resetDemoGridTradesForTests } from "./demo-grid-data";
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
  resetDemoGridTradesForTests();
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

it("serves deterministic precomputed detail and recalculation fixtures in UI demo mode", async () => {
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
  vi.stubEnv("NODE_ENV", "development");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);

  const loaded = await getGridTrade("demo-grid-01");
  const recalculated = await recalculateGridTrade("demo-grid-01");

  expect(loaded).toMatchObject({
    id: "demo-grid-01",
    productName: "黄金 ETF",
    productCode: "518880",
    input: {
      maxPrice: "6.9200",
      minTradeQuantity: "100",
      gearAmplitude: "5",
      perShare: "1500",
    },
    calculation: {
      totalBuyAmount: "5605.2",
      totalProfitAmount: "311.4",
      totalProfitRate: "5.5556",
    },
  });
  expect(loaded.calculation.items).toHaveLength(3);
  expect(loaded.calculation.items[0]).toEqual({
    sequence: 1,
    gridType: 1,
    gear: "5",
    buyPrice: "6.574",
    buyCount: "300",
    buyAmount: "1972.2",
    sellPrice: "6.92",
    sellCount: "300",
    sellAmount: "2076",
    profitAmount: "103.8",
    profitRate: "5.2632",
    keepProfit: "34.6",
    keepCount: "5",
  });
  expect(recalculated).toEqual(loaded);
  expect(recalculated).not.toBe(loaded);
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps demo create, update, list, and delete mutations coherent without HTTP", async () => {
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
  vi.stubEnv("NODE_ENV", "development");
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const createdInput = {
    ...validInput,
    productName: "测试网格",
    productCode: "DEMO-CREATED",
  };

  const created = await createGridTrade(createdInput);
  expect(created).toMatchObject({
    id: "demo-grid-created-01",
    productName: "测试网格",
    productCode: "DEMO-CREATED",
    updatedAt: "2026-09-02T00:00:00.001Z",
  });
  await expect(getGridTrade(created.id)).resolves.toEqual(created);

  const updated = await updateGridTrade(created.id, {
    ...createdInput,
    productName: "已更新网格",
    expectedUpdatedAt: created.updatedAt,
  });
  expect(updated).toMatchObject({
    id: created.id,
    productName: "已更新网格",
    updatedAt: "2026-09-02T00:00:00.002Z",
  });
  const searched = await listGridTrades({ q: "DEMO-CREATED" });
  expect(searched.items.map((item) => item.productName)).toEqual(["已更新网格"]);

  await expect(deleteGridTrade(created.id)).resolves.toBeUndefined();
  await expect(getGridTrade(created.id)).rejects.toMatchObject({
    name: "ClientApiError",
    status: 404,
    code: "GRID_TRADE_NOT_FOUND",
    message: "网格产品不存在",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it("resets the module-local demo repository deterministically for test isolation", async () => {
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
  vi.stubEnv("NODE_ENV", "development");
  resetDemoGridTradesForTests();

  const created = await createGridTrade({
    ...validInput,
    productCode: "RESET-ME",
  });
  expect(created.id).toBe("demo-grid-created-01");

  resetDemoGridTradesForTests();
  await expect(getGridTrade(created.id)).rejects.toMatchObject({
    status: 404,
    code: "GRID_TRADE_NOT_FOUND",
  });
  const recreated = await createGridTrade({
    ...validInput,
    productCode: "RESET-ME-AGAIN",
  });
  expect(recreated.id).toBe("demo-grid-created-01");
});

it("returns controller-compatible demo conflict errors", async () => {
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
  vi.stubEnv("NODE_ENV", "development");

  await expect(createGridTrade({
    ...validInput,
    productCode: "518880",
  })).rejects.toMatchObject({
    name: "ClientApiError",
    status: 409,
    code: "PRODUCT_CODE_CONFLICT",
    requestId: "demo-product-code-conflict",
    fieldErrors: { productCode: ["当前账号已存在相同产品代码"] },
  });

  const loaded = await getGridTrade("demo-grid-01");
  await expect(updateGridTrade(loaded.id, {
    ...loaded.input,
    expectedUpdatedAt: "2025-01-01T00:00:00.000Z",
  })).rejects.toMatchObject({
    name: "ClientApiError",
    status: 409,
    code: "EDIT_CONFLICT",
    message: "产品已被其他请求更新",
    requestId: "demo-edit-conflict",
  });
});

it("keeps production detail and mutation functions on their existing HTTP branches", async () => {
  vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "0");
  vi.stubEnv("NODE_ENV", "development");
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json(detail))
    .mockResolvedValueOnce(Response.json(detail))
    .mockResolvedValueOnce(Response.json(detail))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(Response.json(detail));
  vi.stubGlobal("fetch", fetcher);

  await getGridTrade(detail.id);
  await createGridTrade(validInput);
  await updateGridTrade(detail.id, {
    ...validInput,
    expectedUpdatedAt: detail.updatedAt,
  });
  await deleteGridTrade(detail.id);
  await recalculateGridTrade(detail.id);

  expect(fetcher.mock.calls.map(([path, init]) => [path, init?.method ?? "GET"])).toEqual([
    [`/api/v1/grid-trades/${detail.id}`, "GET"],
    ["/api/v1/grid-trades", "POST"],
    [`/api/v1/grid-trades/${detail.id}`, "PATCH"],
    [`/api/v1/grid-trades/${detail.id}`, "DELETE"],
    [`/api/v1/grid-trades/${detail.id}/recalculate`, "POST"],
  ]);
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
