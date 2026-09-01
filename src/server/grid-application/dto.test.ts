import { describe, expect, it } from "vitest";

import { parseGridCreate, parseGridUpdate } from "@/server/grid-application/dto";

const createBody = {
  productCode: "DEMO",
  maxPrice: "1",
  minTradeQuantity: "100",
  gearAmplitude: "5",
  perShare: "2000",
  keepShare: 2,
  increaseAmplitude: 5,
  maxAmplitude: 60,
  isShort: false,
};

describe("grid mutation DTOs", () => {
  it("applies documented create defaults without accepting owner identity", () => {
    expect(parseGridCreate(createBody)).toEqual({
      ...createBody,
      productName: null,
      mediumAmplitude: null,
      bigAmplitude: null,
      category: null,
      sortOrder: 0,
      algorithmVersion: "android-v2.1.0",
    });
  });

  it.each(["ownerId", "algorithmVersion", "unexpected"])("rejects unknown create field %s", (field) => {
    expect(() => parseGridCreate({ ...createBody, [field]: "attacker" })).toThrow();
  });

  it("requires an optimistic lock timestamp for updates", () => {
    expect(() => parseGridUpdate({ productName: "changed" })).toThrow();
    expect(
      parseGridUpdate({ expectedUpdatedAt: "2026-09-01T00:00:00.000Z", productName: "changed" }),
    ).toEqual({ expectedUpdatedAt: "2026-09-01T00:00:00.000Z", productName: "changed" });
  });
});
