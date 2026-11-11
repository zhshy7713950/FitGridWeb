import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
it("mirrors numeric duplicate prevention and independent rule management in the UI demo", async () => {
  const { demoApi } = await import("./demo-price-alerts");
  const instrument = demoApi.resolve("cn", "518880");
  const condition = { kind: "price", direction: "up", targetPrice: "10" } as const;
  const first = demoApi.create({ instrumentId: instrument.id, condition, enabled: false });
  expect(() => demoApi.create({ instrumentId: instrument.id, condition: { ...condition, targetPrice: "10.00" }, enabled: true })).toThrow("已存在相同提醒");
  const second = demoApi.create({ instrumentId: instrument.id, condition: { ...condition, direction: "down" }, enabled: false });
  expect(() => demoApi.update(second.id, { expectedVersion: 1, condition })).toThrow("已存在相同提醒");
  expect(demoApi.get(second.id).version).toBe(1);
  const updated = demoApi.update(first.id, { expectedVersion: 1, condition: { ...condition, targetPrice: "10.00" } });
  expect(updated.condition).toEqual({ ...condition, targetPrice: "10.00" });
  demoApi.remove(first.id);
  expect(demoApi.create({ instrumentId: instrument.id, condition, enabled: false }).id).not.toBe(first.id);
  expect(demoApi.get(second.id).enabled).toBe(false);
  const items = demoApi.list().items;
  expect(items[0].createdAt >= items[items.length - 1].createdAt).toBe(true);
  expect(items.findIndex((rule) => rule.id === second.id)).toBeLessThan(items.findIndex((rule) => rule.id === "demo-alert-1"));
});
it("recognizes numerically equal percentages as duplicates", async () => {
  const { demoApi } = await import("./demo-price-alerts");
  const instrument = demoApi.resolve("cn", "518880");
  const condition = { kind: "ma_deviation", direction: "down", days: 20, percent: "5" } as const;
  demoApi.create({ instrumentId: instrument.id, condition, enabled: false });
  expect(() => demoApi.create({ instrumentId: instrument.id, condition: { ...condition, percent: "05.00" }, enabled: false })).toThrow("已存在相同提醒");
});
