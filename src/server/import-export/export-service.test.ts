import { describe, expect, it } from "vitest";

import { ExportService } from "@/server/import-export/export-service";
import { GridService } from "@/server/grid-application/grid-service";
import { InMemoryGridDatabase } from "@/server/grid-application/in-memory-grid-store";

const createBody = {
  productName: "Demo",
  productCode: "DEMO",
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

describe("ExportService", () => {
  it("emits Android-compatible numeric calculations without Web identity", async () => {
    const database = new InMemoryGridDatabase(new Date("2026-09-01T00:00:00Z"));
    await new GridService(database.scope).create("owner-a", createBody);
    const exported = await new ExportService(database.scope, "owner-secret-32-characters-minimum").android(
      "owner-a",
    );

    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      productCode: "DEMO",
      totalBuyAmount: 53225,
      totalProfitAmount: 9880,
      isShort: false,
    });
    expect(exported[0].gridItems[0].buyPrice).toBeTypeOf("number");
    expect(exported[0]).not.toHaveProperty("id");
    expect(exported[0]).not.toHaveProperty("ownerId");
  });

  it("emits a versioned Web backup with an anonymous stable ownerRef", async () => {
    const database = new InMemoryGridDatabase(new Date("2026-09-01T00:00:00Z"));
    await new GridService(database.scope).create("owner-a", createBody);
    const service = new ExportService(
      database.scope,
      "owner-secret-32-characters-minimum",
      () => new Date("2026-09-01T12:00:00Z"),
    );
    const backup = await service.web("owner-a");

    expect(backup).toMatchObject({
      format: "fitgridweb-backup",
      formatVersion: "1.0.0",
      exportedAt: "2026-09-01T12:00:00.000Z",
      ownerRef: expect.stringMatching(/^hmac-sha256:[0-9a-f]{64}$/),
      products: [{ productCode: "DEMO", maxPrice: "1", algorithmVersion: "android-v2.1.0" }],
    });
    expect(JSON.stringify(backup)).not.toContain("owner-a");
  });
});
