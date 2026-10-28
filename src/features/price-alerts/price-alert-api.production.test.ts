import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.doUnmock("./demo-price-alerts"); vi.resetModules(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it("keeps production on authenticated HTTP even if a demo flag is present", async () => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
  const demoLoaded = vi.fn(); vi.doMock("./demo-price-alerts", () => { demoLoaded(); return {}; });
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ items: [] })));
  vi.stubGlobal("fetch", fetcher);
  const { alertApi } = await import("./price-alert-api");
  await alertApi.list();
  expect(demoLoaded).not.toHaveBeenCalled();
  expect(fetcher.mock.calls[0][0]).toBe("/api/v1/price-alerts");
});
