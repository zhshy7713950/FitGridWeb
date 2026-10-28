import { afterEach, describe, expect, it, vi } from "vitest";
import { PriceAlertService } from "./service";
import type { AlertRepository } from "./repository";
import type { AlertCondition } from "./types";

const product = { id: "instrument", code: "600519.SH", name: "贵州茅台", market: "cn", currency: "CNY", kind: "stock", tencent: "sh600519", yahoo: null, eastmoney: "1.600519" };
const condition: AlertCondition = { kind: "ma_touch", direction: "up", days: 300 };
function daily(count: number, provider = "tencent") {
  const dates = Array.from({ length: 1000 }, (_, n) => new Date(Date.parse("2026-10-27T12:00:00Z") - n * 86400000))
    .filter((d) => ![0, 6].includes(d.getUTCDay())).slice(0, count).reverse().map((d) => d.toISOString().slice(0, 10));
  return provider === "tencent" ? { code: 0, data: { sh600519: { qfqday: dates.map((date) => [date, "100", "100", "100", "100"]) } } }
    : { rc: 0, data: { market: 1, code: "600519", klines: dates.map((date) => `${date},100,100,100,100`) } };
}
function setup(now = "2026-10-28T02:00:00Z") {
  const row = { id: "rule", ownerId: "owner", instrument: product, condition, enabled: false, version: 2, deletedAt: null };
  const repository = {
    clock: () => Date.parse(now),
    prisma: { marketInstrument: { findUnique: vi.fn().mockResolvedValue(product) } },
    detail: vi.fn().mockResolvedValue(row), basis: vi.fn().mockResolvedValue(null), saveSource: vi.fn(),
    create: vi.fn(async (_owner: string, input: Record<string, unknown>) => ({ ...row, ...input })),
    update: vi.fn(async (_owner: string, _id: string, input: Record<string, unknown>) => ({ ...row, ...input })),
  };
  const service = new PriceAlertService(repository as unknown as AlertRepository, { encryptionKey: "ab".repeat(32), baseUrl: "https://test.invalid", beforeRequest: async () => {} });
  return { service, repository };
}
afterEach(() => vi.unstubAllGlobals());
describe("save-time daily history validation", () => {
  it("rejects a 300-day rule with a proven 200-close history before writing, including paused saves", async () => {
    const { service, repository } = setup();
    vi.stubGlobal("fetch", async (url: string) => Response.json(daily(200, url.includes("eastmoney") ? "eastmoney" : "tencent")));
    await expect(service.create("owner", { instrumentId: product.id, condition, enabled: false })).rejects.toMatchObject({ status: 422, code: "HISTORY_INSUFFICIENT", message: expect.stringMatching(/200.*201/) });
    expect(repository.create).not.toHaveBeenCalled();
  });
  it("uses sufficient backup history when primary history is short", async () => {
    const { service, repository } = setup();
    vi.stubGlobal("fetch", async (url: string) => Response.json(daily(url.includes("eastmoney") ? 499 : 200, url.includes("eastmoney") ? "eastmoney" : "tencent")));
    await service.create("owner", { instrumentId: product.id, condition: { ...condition, days: 500 }, enabled: false });
    expect(repository.create).toHaveBeenCalledOnce();
  });
  it("does not turn an upstream failure into a claimed history maximum", async () => {
    const { service, repository } = setup();
    vi.stubGlobal("fetch", async (url: string) => { if (url.includes("eastmoney")) throw new Error("network unavailable"); return Response.json(daily(200)); });
    await expect(service.create("owner", { instrumentId: product.id, condition, enabled: false })).rejects.toMatchObject({ status: 503, code: "HISTORY_UNAVAILABLE" });
    expect(repository.create).not.toHaveBeenCalled();
  });
  it("rechecks changed conditions and resume requests, but keeps pause and price saves independent of feeds", async () => {
    const { service, repository } = setup();
    const fetch = vi.fn(async (url: string) => Response.json(daily(200, url.includes("eastmoney") ? "eastmoney" : "tencent")));
    vi.stubGlobal("fetch", fetch);
    await expect(service.update("owner", "rule", { expectedVersion: 2, enabled: true })).rejects.toMatchObject({ code: "HISTORY_INSUFFICIENT" });
    await expect(service.update("owner", "rule", { expectedVersion: 2, condition })).rejects.toMatchObject({ code: "HISTORY_INSUFFICIENT" });
    fetch.mockClear();
    await service.update("owner", "rule", { expectedVersion: 2, enabled: false });
    await service.create("owner", { instrumentId: product.id, condition: { kind: "price", direction: "up", targetPrice: "100" }, enabled: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledOnce();
  });
  it("checks owner scope and edit version before querying upstream history", async () => {
    const { service, repository } = setup();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(service.update("owner", "rule", { expectedVersion: 1, enabled: true })).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
    repository.detail.mockResolvedValueOnce(null);
    await expect(service.update("another", "rule", { expectedVersion: 2, enabled: true })).rejects.toMatchObject({ code: "ALERT_NOT_FOUND" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("replaces an old truncated cache and avoids writing future-session validation into runtime cache", async () => {
    const { service, repository } = setup();
    const closes = (daily(249) as { data: { sh600519: { qfqday: string[][] } } }).data.sh600519.qfqday.map((r) => ({ date: r[0], close: r[2] }));
    repository.basis.mockResolvedValue({ provider: "tencent", sessionDate: "2026-10-28", fetchedAt: "2026-10-28T01:00:00Z", adjustment: "qfq", closes });
    const fetch = vi.fn(async () => Response.json(daily(640))); vi.stubGlobal("fetch", fetch);
    await service.create("owner", { instrumentId: product.id, condition: { ...condition, days: 500 }, enabled: false });
    expect(fetch).toHaveBeenCalledOnce();
    expect(repository.saveSource).toHaveBeenCalledOnce();
    const weekend = setup("2026-10-31T04:00:00Z");
    const friday = daily(640) as { data: { sh600519: { qfqday: string[][] } } };
    friday.data.sh600519.qfqday.push(["2026-10-28", "100", "100", "100", "100"], ["2026-10-29", "100", "100", "100", "100"], ["2026-10-30", "100", "100", "100", "100"]);
    fetch.mockResolvedValue(Response.json(friday));
    await weekend.service.create("owner", { instrumentId: product.id, condition, enabled: false });
    expect(weekend.repository.saveSource).not.toHaveBeenCalled();
  });
});
