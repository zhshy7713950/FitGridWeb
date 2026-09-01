import { readFile } from "node:fs/promises";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

import fixture from "../../../docs/fit-replication/fixtures/grid-algorithm-v2.1.0.json";
import { GridService } from "@/server/grid-application/grid-service";
import { InMemoryGridDatabase } from "@/server/grid-application/in-memory-grid-store";
import { ExportService } from "@/server/import-export/export-service";

async function schema(name: string) {
  return JSON.parse(await readFile(
    path.join(process.cwd(), "docs/fit-replication/contracts", name),
    "utf8",
  )) as object;
}

function validator(document: object) {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(document);
}

describe("published JSON Schema contracts", () => {
  it("accepts every characterized Android v2.1.0 result", async () => {
    const validate = validator(await schema("android-grid-trade.schema.json"));
    expect(validate(fixture.cases.map((item) => item.androidResult)), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts the production Web backup exporter output", async () => {
    const database = new InMemoryGridDatabase(new Date("2026-09-01T00:00:00Z"));
    await new GridService(database.scope).create("owner-a", {
      productCode: "DEMO",
      maxPrice: "1",
      minTradeQuantity: "100",
      gearAmplitude: "5",
      perShare: "2000",
      keepShare: 2,
      increaseAmplitude: 5,
      maxAmplitude: 60,
      isShort: false,
    });
    const backup = await new ExportService(
      database.scope,
      "owner-secret-32-characters-minimum",
      () => new Date("2026-09-01T12:00:00Z"),
    ).web("owner-a");
    const validate = validator(await schema("web-backup.schema.json"));
    expect(validate(backup), JSON.stringify(validate.errors)).toBe(true);
  });
});
