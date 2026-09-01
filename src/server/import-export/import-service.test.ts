import { describe, expect, it } from "vitest";

import {
  ImportService,
  type ImportPreviewPayload,
  type ImportRepository,
} from "@/server/import-export/import-service";

class MemoryImports implements ImportRepository {
  existing = new Map<string, Set<string>>();
  previews = new Map<string, { ownerId: string; payload: ImportPreviewPayload; expiresAt: Date }>();

  async existingCodes(ownerId: string, codes: string[]): Promise<Set<string>> {
    const own = this.existing.get(ownerId) ?? new Set<string>();
    return new Set(codes.filter((code) => own.has(code)));
  }
  async savePreview(
    ownerId: string,
    tokenDigest: string,
    _fileDigest: string,
    payload: ImportPreviewPayload,
    expiresAt: Date,
  ): Promise<void> {
    this.previews.set(tokenDigest, { ownerId, payload, expiresAt });
  }
  async commit(
    ownerId: string,
    tokenDigest: string,
    policy: "skip" | "overwrite",
    now: Date,
  ) {
    const preview = this.previews.get(tokenDigest);
    if (!preview || preview.ownerId !== ownerId || preview.expiresAt <= now) return null;
    this.previews.delete(tokenDigest);
    const own = this.existing.get(ownerId) ?? new Set<string>();
    let created = 0;
    let overwritten = 0;
    let skipped = 0;
    for (const item of preview.payload.valid) {
      if (own.has(item.input.productCode)) {
        if (policy === "skip") skipped += 1;
        else overwritten += 1;
      } else {
        own.add(item.input.productCode);
        created += 1;
      }
    }
    this.existing.set(ownerId, own);
    return { created, overwritten, skipped, invalid: preview.payload.invalidCount };
  }
}

const androidFile = Buffer.from(
  JSON.stringify([
    { productCode: "NEW", maxPrice: 1, perShare: 2000, gearAmplitude: 5, maxAmplitude: 60 },
    { productCode: "EXISTING", maxPrice: 1, perShare: 2000, gearAmplitude: 5, maxAmplitude: 60 },
  ]),
);

describe("ImportService", () => {
  it("binds preview and conflict checks to the current owner", async () => {
    const repository = new MemoryImports();
    repository.existing.set("owner-a", new Set(["EXISTING"]));
    repository.existing.set("owner-b", new Set());
    const service = new ImportService(repository);
    const preview = await service.preview("owner-a", androidFile, new Date("2026-09-01T00:00:00Z"));

    expect(preview.creates.map((item) => item.productCode)).toEqual(["NEW"]);
    expect(preview.conflicts.map((item) => item.productCode)).toEqual(["EXISTING"]);
    await expect(
      service.commit("owner-b", preview.previewToken, "overwrite", new Date("2026-09-01T00:01:00Z")),
    ).rejects.toMatchObject({ code: "IMPORT_PREVIEW_NOT_FOUND" });
    await expect(
      service.commit("owner-a", preview.previewToken, "overwrite", new Date("2026-09-01T00:01:00Z")),
    ).resolves.toEqual({ created: 1, overwritten: 1, skipped: 0, invalid: 0 });
  });

  it("makes preview tokens one-time and 15 minutes long", async () => {
    const service = new ImportService(new MemoryImports());
    const preview = await service.preview("owner-a", androidFile, new Date("2026-09-01T00:00:00Z"));
    expect(preview.expiresAt).toBe("2026-09-01T00:15:00.000Z");
    await service.commit("owner-a", preview.previewToken, "skip", new Date("2026-09-01T00:01:00Z"));
    await expect(
      service.commit("owner-a", preview.previewToken, "skip", new Date("2026-09-01T00:02:00Z")),
    ).rejects.toMatchObject({ code: "IMPORT_PREVIEW_NOT_FOUND" });
  });
});
