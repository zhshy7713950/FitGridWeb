import { describe, expect, it } from "vitest";

import { ApiError } from "@/server/http/api-error";
import { GridService } from "@/server/grid-application/grid-service";
import { InMemoryGridDatabase } from "@/server/grid-application/in-memory-grid-store";

const createBody = {
  productName: "Demo",
  productCode: "SAME-CODE",
  maxPrice: "1",
  minTradeQuantity: "100",
  gearAmplitude: "5",
  perShare: "2000",
  keepShare: 2,
  increaseAmplitude: 5,
  mediumAmplitude: 15,
  bigAmplitude: 30,
  maxAmplitude: 60,
  isShort: false,
};

function setup() {
  const database = new InMemoryGridDatabase(new Date("2026-09-01T00:00:00.000Z"));
  return { database, service: new GridService(database.scope) };
}

describe("GridService", () => {
  it("creates calculated records and isolates same-code products by owner", async () => {
    const { service } = setup();
    const createdA = await service.create("owner-a", createBody);
    const createdB = await service.create("owner-b", createBody);

    expect(createdA.calculation.totalBuyAmount).toBe("53225");
    expect(createdB.productCode).toBe("SAME-CODE");
    await expect(service.list("owner-a", { limit: 20 })).resolves.toMatchObject({
      items: [{ id: createdA.id }],
    });
    await expect(service.get("owner-a", createdB.id)).rejects.toMatchObject({
      status: 404,
      code: "GRID_TRADE_NOT_FOUND",
    });
    await expect(service.recalculate("owner-a", createdB.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.update("owner-a", createdB.id, {
        expectedUpdatedAt: createdB.updatedAt,
        productName: "stolen",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a duplicate code only inside the current owner", async () => {
    const { service } = setup();
    await service.create("owner-a", createBody);
    await expect(service.create("owner-a", createBody)).rejects.toMatchObject({
      status: 409,
      code: "PRODUCT_CODE_CONFLICT",
    });
  });

  it("searches and paginates in stable sort/time/id order", async () => {
    const { service } = setup();
    await service.create("owner-a", { ...createBody, productCode: "B", sortOrder: 1 });
    await service.create("owner-a", { ...createBody, productCode: "A", sortOrder: 0 });
    await service.create("owner-a", { ...createBody, productCode: "C", sortOrder: 1 });

    const first = await service.list("owner-a", { q: "A", limit: 1 });
    expect(first.items.map((item) => item.productCode)).toEqual(["A"]);
    const pageOne = await service.list("owner-a", { limit: 2 });
    const pageTwo = await service.list("owner-a", { limit: 2, cursor: pageOne.nextCursor! });
    expect([...pageOne.items, ...pageTwo.items].map((item) => item.productCode)).toEqual([
      "A",
      "B",
      "C",
    ]);
    await expect(service.list("owner-b", { limit: 2, cursor: pageOne.nextCursor! })).rejects.toMatchObject({
      code: "SIGNED_TOKEN_INVALID",
    });
  });

  it("updates with optimistic locking and permits retaining its own code", async () => {
    const { service, database } = setup();
    const created = await service.create("owner-a", createBody);
    database.advanceClock(1_000);
    const updated = await service.update("owner-a", created.id, {
      expectedUpdatedAt: created.updatedAt,
      productName: "Changed",
      productCode: "SAME-CODE",
    });
    expect(updated.productName).toBe("Changed");
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);

    await expect(
      service.update("owner-a", created.id, {
        expectedUpdatedAt: created.updatedAt,
        productName: "Stale",
      }),
    ).rejects.toMatchObject({ status: 409, code: "EDIT_CONFLICT" });
  });

  it("rejects changing a code to another product owned by the same account", async () => {
    const { service } = setup();
    const first = await service.create("owner-a", { ...createBody, productCode: "A" });
    await service.create("owner-a", { ...createBody, productCode: "B" });
    await expect(
      service.update("owner-a", first.id, {
        expectedUpdatedAt: first.updatedAt,
        productCode: "B",
      }),
    ).rejects.toMatchObject({ status: 409, code: "PRODUCT_CODE_CONFLICT" });
  });

  it("recalculates idempotently and physically deletes only owned records", async () => {
    const { service } = setup();
    const created = await service.create("owner-a", createBody);
    expect(await service.recalculate("owner-a", created.id)).toEqual(created);
    await expect(service.delete("owner-b", created.id)).rejects.toBeInstanceOf(ApiError);
    await expect(service.delete("owner-a", created.id)).resolves.toBeUndefined();
    await expect(service.get("owner-a", created.id)).rejects.toMatchObject({ status: 404 });
  });
});
