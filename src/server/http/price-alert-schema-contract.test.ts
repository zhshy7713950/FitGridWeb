import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { beforeAll, describe, expect, it } from "vitest";
import { ruleSchema } from "@/server/price-alerts/engine";
import { Prisma } from "@/generated/prisma/client";
import type { AlertRepository } from "@/server/price-alerts/repository";
import { PriceAlertService, publicRule } from "@/server/price-alerts/service";

let schemas: Record<string, object>;
beforeAll(async () => {
  const document = parse(await readFile(path.join(process.cwd(), "docs/fit-replication/contracts/openapi.yaml"), "utf8"));
  schemas = JSON.parse(JSON.stringify(document.components.schemas).replaceAll("#/components/schemas/", "#/$defs/"));
});
function validate(name: string, payload: unknown) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile({ $defs: schemas, $ref: `#/$defs/${name}` })(payload);
}
const id = "00000000-0000-4000-8000-000000000001";
const time = "2026-10-27T06:00:00.000Z";
const price = { kind: "price", direction: "up", targetPrice: "100.01" };

describe("published alert JSON schemas", () => {
  it("publishes a bounded authenticated candidate search without persisted IDs or caller ownership", () => {
    const item = { code: "510880.SH", name: "红利ETF华泰柏瑞", market: "cn", currency: "CNY", kind: "etf", exchange: "上海证券交易所" };
    expect(validate("MarketInstrumentSearchRequest", { market: "cn", query: "红利" })).toBe(true);
    for (const body of [{ market: "cn", query: " " }, { market: "cn", query: "x".repeat(65) }, { market: "cn", query: "红利", ownerId: id }]) expect(validate("MarketInstrumentSearchRequest", body)).toBe(false);
    expect(validate("MarketInstrumentSearchResponse", { items: [item] })).toBe(true);
    expect(validate("MarketInstrumentSearchResponse", { items: [] })).toBe(true);
    expect(validate("MarketInstrumentSearchResponse", { items: Array(11).fill(item) })).toBe(false);
    expect(validate("MarketInstrumentCandidate", { ...item, id })).toBe(false);
  });

  it.each([
    [{ kind: "price", direction: "up", targetPrice: "0.0000000001" }, true],
    [{ kind: "price", direction: "down", targetPrice: "99999999999999999999.9999999999" }, true],
    [{ kind: "price", direction: "up", targetPrice: "0" }, false],
    [{ kind: "price", direction: "up", targetPrice: "0.000" }, false],
    [{ kind: "price", direction: "up", targetPrice: 100 }, false],
    [{ kind: "price", direction: "up", targetPrice: "01.1" }, false],
    [{ kind: "price", direction: "up", targetPrice: "1e2" }, false],
    [{ kind: "price", direction: "up", targetPrice: "1.00000000001" }, false],
    [{ kind: "ma_touch", direction: "down", days: 2 }, true],
    [{ kind: "ma_touch", direction: "up", days: 500 }, true],
    [{ kind: "ma_touch", direction: "up", days: 1 }, false],
    [{ kind: "ma_touch", direction: "up", days: 501 }, false],
    [{ kind: "ma_touch", direction: "up", days: 2.5 }, false],
    [{ kind: "ma_deviation", direction: "down", days: 20, percent: "0.01" }, true],
    [{ kind: "ma_deviation", direction: "up", days: 20, percent: "99.99" }, true],
    [{ kind: "ma_deviation", direction: "up", days: 20, percent: "00.01" }, true],
    [{ kind: "ma_deviation", direction: "up", days: 20, percent: "0.00" }, false],
    [{ kind: "ma_deviation", direction: "up", days: 20, percent: "100" }, false],
    [{ kind: "ma_deviation", direction: "up", days: 20, percent: "0.001" }, false],
    [{ kind: "ma_touch", direction: "sideways", days: 20 }, false],
    [{ ...price, days: 20 }, false],
  ])("matches engine validation for %j", (condition, accepted) => {
    expect(ruleSchema.safeParse(condition).success).toBe(accepted);
    expect(validate("AlertCondition", condition)).toBe(accepted);
  });

  it("requires versioned edits and at least one change while rejecting client ownership fields", () => {
    expect(validate("PriceAlertCreateRequest", { instrumentId: id, condition: price, enabled: false })).toBe(true);
    expect(validate("PriceAlertCreateRequest", { instrumentId: id, condition: price })).toBe(false);
    expect(validate("PriceAlertCreateRequest", { instrumentId: id, condition: price, enabled: false, ownerId: id })).toBe(false);
    for (const body of [{ expectedVersion: 1, enabled: false }, { expectedVersion: 2, condition: price }]) expect(validate("PriceAlertUpdateRequest", body)).toBe(true);
    for (const body of [{ expectedVersion: 1 }, { enabled: false }, { expectedVersion: 0, enabled: true }, { expectedVersion: 1, instrumentId: id }]) expect(validate("PriceAlertUpdateRequest", body)).toBe(false);
    expect(validate("PriceAlertDeleteRequest", { expectedVersion: 1 })).toBe(true);
    expect(validate("PriceAlertDeleteRequest", {})).toBe(false);
  });

  it("accepts public rules and keeps ownership and notification keys out of DTOs", () => {
    const rule = publicRule({ id, ownerId: id, instrumentId: id, condition: price, enabled: false, version: 1, armed: true, cursor: null, activeFrom: time, continuityDegraded: false, lastError: null, lastSuccess: null, lastEvaluation: null, deletedAt: null, createdAt: time, updatedAt: time, instrument: { id, code: "SPY.US", name: "SPY", market: "us", currency: "USD", kind: "etf", tencent: null, yahoo: "SPY", eastmoney: null, quote: null, createdAt: time } });
    expect(validate("PriceAlert", rule)).toBe(true);
    expect(validate("PriceAlert", { ...rule, ownerId: id })).toBe(false);
    const channel = { configured: true, tested: false, testedAt: null, lastError: null, encryptionReady: true };
    expect(validate("NotificationChannelStatus", channel)).toBe(true);
    expect(validate("NotificationChannelStatus", { ...channel, deviceKey: "private-device-key" })).toBe(false);
    expect(validate("NotificationChannelStatus", { ...channel, keyCipher: "private-cipher" })).toBe(false);
    expect(validate("NotificationChannelRequest", { deviceKey: "test_device-key" })).toBe(true);
    expect(validate("NotificationChannelRequest", { deviceKey: "https://other.invalid" })).toBe(false);
  });

  it("accepts decimal history without internal identifiers and enforces UTC timestamps", () => {
    const event = { id, ruleId: id, version: 1, minuteStart: time, minuteEnd: "2026-10-27T06:01:00.000Z", price: "100.1234567890", threshold: "100", ma: null, provider: "yahoo", evidence: { delayed: false }, createdAt: time, delivery: { status: "history", lastError: null, acceptedAt: null, attempts: 0 } };
    expect(validate("PriceAlertEvent", event)).toBe(true);
    for (const extra of [{ ownerId: id }, { outboxId: id }, { price: 100 }, { minuteStart: "2026-10-27T14:00:00+08:00" }, { delivery: { ...event.delivery, id } }]) expect(validate("PriceAlertEvent", { ...event, ...extra })).toBe(false);
  });

  it("validates serialized service history and an opaque composite nextCursor", async () => {
    const events = Array.from({ length: 50 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, ownerId: id, outboxId: id, ruleId: id, version: 1, minuteStart: new Date(time), minuteEnd: new Date("2026-10-27T06:01:00.000Z"), price: new Prisma.Decimal("100.1234567890"), threshold: new Prisma.Decimal("100"), ma: null, provider: "yahoo", evidence: {}, createdAt: new Date(time), delivery: { id, status: "accepted", lastError: null, acceptedAt: new Date(time), attempts: 1 } }));
    const service = new PriceAlertService({ events: async () => events } as unknown as AlertRepository, { encryptionKey: "a".repeat(64), baseUrl: "https://fitgrid.example/fitgrid", beforeRequest: async () => {} });
    const page = JSON.parse(JSON.stringify(await service.events(id, id)));
    expect(validate("PriceAlertEventPage", page)).toBe(true);
    expect(page.items[0].price).toBe("100.123456789");
    expect(page.nextCursor.length).toBeLessThanOrEqual(512);
    expect(JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8"))).toEqual({ minuteStart: time, id: "00000000-0000-4000-8000-000000000050" });
    expect(validate("AlertEventCursor", page.nextCursor)).toBe(true);
    expect(validate("AlertEventCursor", time)).toBe(false);
    expect(validate("AlertEventCursor", "x".repeat(513))).toBe(false);
  });

  it("accepts documented normalized examples and page status variants", () => {
    for (const name of ["AlertPriceInput", "AlertPercentInput", "MarketInstrumentResolveRequest"]) {
      const examples = (schemas[name] as { examples: unknown[] }).examples;
      for (const example of examples) expect(validate(name, example)).toBe(true);
    }
    for (const status of [
      { calendarWarnings: [], nextRunAt: null, lastScan: null },
      { calendarWarnings: ["未配置交易日历"], nextRunAt: time, lastScan: { market: "us", status: "complete", windowEnd: time, finishedAt: time } },
    ]) expect(validate("PriceAlertPage", { items: [], status })).toBe(true);
    expect(validate("NotificationTestResponse", { accepted: true })).toBe(true);
    expect(validate("NotificationTestResponse", { accepted: false })).toBe(false);
  });

  it("accepts v3/v4 restore previews with optional nonnegative alert counts", () => {
    const legacy = { users: 1, gridTrades: 2, invitations: 0, importPreviews: 0 };
    expect(validate("RestorePreview", legacy)).toBe(true);
    expect(validate("RestorePreview", { ...legacy, marketInstruments: 1, priceAlerts: 2, priceAlertEvents: 3 })).toBe(true);
    for (const field of ["marketInstruments", "priceAlerts", "priceAlertEvents"]) expect(validate("RestorePreview", { ...legacy, [field]: -1 })).toBe(false);
  });
});
