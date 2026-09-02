import { afterEach, expect, it, vi } from "vitest";

import { listGridTrades } from "./grid-api";

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
