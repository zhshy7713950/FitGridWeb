import { afterEach, expect, it, vi } from "vitest";

import { listGridTrades } from "./grid-api";

afterEach(() => vi.unstubAllGlobals());

it("encodes q, cursor, and the fixed 20-item limit", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ items: [], nextCursor: null }));
  vi.stubGlobal("fetch", fetcher);

  await listGridTrades({ q: "黄金 ETF", cursor: "signed+cursor" });

  expect(fetcher.mock.calls[0][0]).toBe(
    "/api/v1/grid-trades?q=%E9%BB%84%E9%87%91+ETF&cursor=signed%2Bcursor&limit=20",
  );
});
