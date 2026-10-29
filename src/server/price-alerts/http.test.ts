import { beforeEach, describe, expect, it, vi } from "vitest";
import * as listRoute from "@/app/api/v1/price-alerts/route";
import * as searchRoute from "@/app/api/v1/market/instruments/search/route";
import { ApiError } from "@/server/http/api-error";
import * as channelRoute from "@/app/api/v1/settings/notifications/route";
import { PriceAlertService } from "./service";
import type { AlertRepository } from "./repository";

const context = vi.hoisted(() => ({ authenticated: true, maintenance: false }));
vi.mock("@/server/runtime/services", () => ({ getRuntimeServices: () => ({
  auth: { api: { getSession: async () => context.authenticated ? { user: { id: "d8011707-1a97-4c0a-94f4-49cac040261e", name: "tester", role: "member", status: "active" } } : null } },
  maintenance: { getMaintenanceMode: async () => ({ active: context.maintenance }) },
  alerts: { search: async (market: string, query: string) => ({ items: [{ code: "510880.SH", name: query, market, currency: "CNY", kind: "etf", exchange: "上海证券交易所" }] }), create: async () => { throw new ApiError(503, "HISTORY_UNAVAILABLE", "暂时无法验证均线历史"); }, list: async () => ({ items: [], status: {} }), channelStatus: async () => ({ configured: false, tested: false, encryptionReady: false }), repository: { create: async () => { throw new Error("invalid input must not reach persistence"); } } },
}) }));
function request(path: string, method = "GET", body?: unknown) { return new Request(`https://test.invalid${path}`, { method, headers: { host: "test.invalid", origin: "https://test.invalid", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
beforeEach(() => { context.authenticated = true; context.maintenance = false; });
describe("price alert HTTP boundaries", () => {
  it("requires a session and validated input for real product searches", async () => {
    context.authenticated = false;
    expect((await searchRoute.POST(request("/api/v1/market/instruments/search", "POST", { market: "cn", query: "红利" }))).status).toBe(401);
    context.authenticated = true;
    for (const body of [{ market: "cn", query: " " }, { market: "cn", query: "x".repeat(65) }, { market: "cn", query: "510880", ownerId: "another" }]) {
      expect((await searchRoute.POST(request("/api/v1/market/instruments/search", "POST", body))).status).toBe(422);
    }
    const result = await searchRoute.POST(request("/api/v1/market/instruments/search", "POST", { market: "cn", query: " 红利 " }));
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toContain("no-store");
    expect((await result.json()).items[0]).toMatchObject({ code: "510880.SH", name: "红利" });
  });
  it("routes valid MA writes through the history-checking service instead of direct persistence", async () => {
    const result = await listRoute.POST(request("/api/v1/price-alerts", "POST", { instrumentId: "00000000-0000-4000-8000-000000000001", condition: { kind: "ma_touch", direction: "up", days: 500 }, enabled: false }));
    expect(result.status).toBe(503); expect((await result.json()).code).toBe("HISTORY_UNAVAILABLE");
  });

  it("rejects anonymous reads and caller-provided ownership", async () => {
    context.authenticated = false;
    expect((await listRoute.GET(request("/api/v1/price-alerts"))).status).toBe(401);
    context.authenticated = true;
    expect((await listRoute.GET(request("/api/v1/price-alerts?ownerId=another"))).status).toBe(422);
  });
  it("does not allow cross-origin mutations or operations during maintenance", async () => {
    const cross = new Request("https://test.invalid/api/v1/price-alerts", { method: "POST", headers: { host: "test.invalid", origin: "https://evil.invalid" } });
    expect((await listRoute.POST(cross)).status).toBe(403);
    context.maintenance = true;
    expect((await listRoute.GET(request("/api/v1/price-alerts"))).status).toBe(503);
  });
  it("rejects invalid rule payloads before persistence and marks personal reads private", async () => {
    const invalid = await listRoute.POST(request("/api/v1/price-alerts", "POST", { ownerId: "another", enabled: true }));
    expect(invalid.status).toBe(422);
    expect((await listRoute.GET(request("/api/v1/price-alerts"))).headers.get("cache-control")).toContain("no-store");
    const channel = await channelRoute.GET(request("/api/v1/settings/notifications"));
    expect(await channel.json()).toEqual({ configured: false, tested: false, encryptionReady: false });
  });
  it("never exposes encrypted or plaintext key in notification status", async () => {
    const repository = { channel: async () => ({ keyCipher: "sensitive-encrypted-key", testedAt: null, lastError: null, version: 1 }) } as unknown as AlertRepository;
    const service = new PriceAlertService(repository, { encryptionKey: "ab".repeat(32), baseUrl: "https://test.invalid", beforeRequest: async () => {} });
    const status = await service.channelStatus("owner");
    expect(status).toEqual({ configured: true, tested: false, testedAt: null, lastError: null, encryptionReady: true });
    expect(JSON.stringify(status)).not.toContain("sensitive");
  });
  it("bounds alert JSON bodies before parsing so large requests cannot exhaust the web process", async () => {
    const result = await listRoute.POST(request("/api/v1/price-alerts", "POST", { padding: "x".repeat(20000) }));
    expect(result.status).toBe(413);
  });
});
