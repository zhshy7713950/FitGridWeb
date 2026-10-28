import { afterEach, expect, it, vi } from "vitest";
import { alertApi } from "./price-alert-api";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("uses cached own API reads and includes optimistic versions in mutations", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({})));
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("NEXT_PUBLIC_APP_BASE_PATH", "/fitgrid");
  await alertApi.list();
  await alertApi.get("rule-1");
  await alertApi.events("rule-1", "2026-10-27T03:00:00Z");
  await alertApi.update("rule-1", { expectedVersion: 4, enabled: false });
  await alertApi.remove("rule-1", 5);
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    "/fitgrid/api/v1/price-alerts", "/fitgrid/api/v1/price-alerts/rule-1",
    "/fitgrid/api/v1/price-alerts/rule-1/events?before=2026-10-27T03%3A00%3A00Z",
    "/fitgrid/api/v1/price-alerts/rule-1", "/fitgrid/api/v1/price-alerts/rule-1",
  ]);
  expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({ expectedVersion: 4, enabled: false });
  expect(JSON.parse(fetcher.mock.calls[4][1].body)).toEqual({ expectedVersion: 5 });
});
it("writes Bark key only to settings and sends an explicit test request", async () => {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json({ configured: true, tested: false })));
  vi.stubGlobal("fetch", fetcher);
  await alertApi.saveChannel("private-key");
  await alertApi.testChannel();
  expect(fetcher.mock.calls[0][0]).toBe("/api/v1/settings/notifications");
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ deviceKey: "private-key" });
  expect(fetcher.mock.calls[1][0]).toBe("/api/v1/settings/notifications/test");
});
it("supports a coherent development preview without requesting any server or feed", async () => {
  vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("NEXT_PUBLIC_UI_DEMO_MODE", "1");
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const instrument = await alertApi.resolve("us", "AAPL");
  const created = await alertApi.create({ instrumentId: instrument.id, enabled: false, condition: { kind: "ma_touch", days: 20, direction: "down" } });
  expect((await alertApi.get(created.id)).instrument.code).toBe("AAPL");
  const updated = await alertApi.update(created.id, { expectedVersion: created.version, enabled: true });
  expect(updated.version).toBe(created.version + 1);
  await alertApi.remove(created.id, updated.version);
  expect((await alertApi.list()).items.some((rule) => rule.id === created.id)).toBe(false);
  expect((await alertApi.get(created.id)).deletedAt).not.toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
