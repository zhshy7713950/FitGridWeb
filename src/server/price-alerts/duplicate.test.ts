import type { PrismaClient } from "@/generated/prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { AlertRepository } from "./repository";
import type { AlertCondition } from "./types";

const condition: AlertCondition = { kind: "price", direction: "up", targetPrice: "10" };
const current = { id: "rule", instrumentId: "instrument", version: 1, condition, enabled: false, deletedAt: null };
const tx = {
  $queryRaw: vi.fn(), $executeRaw: vi.fn(),
  marketInstrument: { findUnique: vi.fn() },
  priceAlert: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() },
  priceAlertChannel: { findUnique: vi.fn() }, priceAlertOutbox: { updateMany: vi.fn() },
};
const prisma = { $transaction: vi.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)) };
const repo = new AlertRepository(prisma as unknown as PrismaClient);

beforeEach(() => {
  vi.clearAllMocks();
  tx.$queryRaw.mockResolvedValue([{ status: "active" }]);
  tx.marketInstrument.findUnique.mockResolvedValue({ id: "instrument" });
  tx.priceAlert.findMany.mockResolvedValue([]); tx.priceAlert.count.mockResolvedValue(0);
  tx.priceAlert.findUnique.mockResolvedValue(current); tx.priceAlert.update.mockResolvedValue(current);
  tx.priceAlertChannel.findUnique.mockResolvedValue({ testedAt: new Date() });
});

it.each<AlertCondition>([
  { kind: "price", direction: "up", targetPrice: "10.00" },
  { kind: "ma_touch", direction: "down", days: 20 },
  { kind: "ma_deviation", direction: "up", days: 20, percent: "05.00" },
])("rejects a duplicate %j inside the owner write transaction before insertion", async (input) => {
  const existing = input.kind === "price" ? condition : input.kind === "ma_deviation" ? { ...input, percent: "5" } : input;
  tx.priceAlert.findMany.mockResolvedValue([{ condition: existing }]);
  await expect(repo.create("owner", { instrumentId: "instrument", condition: input, enabled: true }))
    .rejects.toMatchObject({ status: 409, code: "ALERT_DUPLICATE", fieldErrors: { condition: ["已存在相同提醒"] } });
  expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.priceAlert.findMany.mock.invocationCallOrder[0]);
  expect(tx.priceAlert.findMany).toHaveBeenCalledWith({ where: { ownerId: "owner", instrumentId: "instrument", deletedAt: null }, select: { condition: true } });
  expect(tx.priceAlert.create).not.toHaveBeenCalled();
});

it("allows different thresholds and directions and preserves original decimal text", async () => {
  tx.priceAlert.findMany.mockResolvedValue([{ condition }]);
  await repo.create("owner", { instrumentId: "instrument", condition: { ...condition, direction: "down", targetPrice: "10.00" }, enabled: false });
  await repo.create("owner", { instrumentId: "instrument", condition: { ...condition, targetPrice: "11.00" }, enabled: false });
  expect(tx.priceAlert.create).toHaveBeenCalledTimes(2);
  expect(tx.priceAlert.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ condition: { ...condition, targetPrice: "11.00" } }) }));
});

it("rejects an edit that duplicates another rule without changing state or cancelling delivery", async () => {
  const changed = { ...condition, targetPrice: "11" };
  tx.priceAlert.findMany.mockResolvedValue([{ condition: changed }]);
  await expect(repo.update("owner", "rule", { expectedVersion: 1, condition: changed })).rejects.toMatchObject({ code: "ALERT_DUPLICATE" });
  expect(tx.priceAlert.findMany).toHaveBeenCalledWith({ where: { ownerId: "owner", instrumentId: "instrument", deletedAt: null, id: { not: "rule" } }, select: { condition: true } });
  expect(tx.priceAlert.update).not.toHaveBeenCalled(); expect(tx.priceAlertOutbox.updateMany).not.toHaveBeenCalled();
});

it.each([
  { enabled: false }, { enabled: true }, { deleted: true }, { condition }, { condition: { ...condition, targetPrice: "10.00" } },
])("keeps legacy duplicates manageable when applying %j", async (patch) => {
  tx.priceAlert.findMany.mockResolvedValue([{ condition }]);
  await repo.update("owner", "rule", { expectedVersion: 1, ...patch });
  expect(tx.priceAlert.findMany).not.toHaveBeenCalled(); expect(tx.priceAlert.update).toHaveBeenCalledOnce();
});

it("checks the editing version before duplicate conditions", async () => {
  await expect(repo.update("owner", "rule", { expectedVersion: 2, condition: { ...condition, targetPrice: "11" } })).rejects.toMatchObject({ code: "EDIT_CONFLICT" });
  expect(tx.priceAlert.findMany).not.toHaveBeenCalled();
});
