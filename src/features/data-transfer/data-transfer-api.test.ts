import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { commitImport, downloadExport, previewImport } from "./data-transfer-api";
import type {
  ExportDownload,
  ImportConflictPolicy,
  ImportPreview,
  ImportPreviewItem,
  ImportReport,
} from "./types";

const preview: ImportPreview = {
  previewToken: "preview-token-with-at-least-thirty-two-characters",
  expiresAt: "2026-09-02T00:15:00.000Z",
  creates: [{ index: 0, productCode: "NEW", warnings: ["已补齐历史字段 category"] }],
  conflicts: [{ index: 1, productCode: "EXISTING" }],
  invalid: [{ index: 2, productCode: "", fieldErrors: { productCode: ["产品代码不能为空"] } }],
  warnings: ["已补齐历史字段 category"],
};

afterEach(() => vi.unstubAllGlobals());

describe("transfer DTOs", () => {
  it("matches the server import response fields and optional preview diagnostics", () => {
    expectTypeOf<ImportConflictPolicy>().toEqualTypeOf<"skip" | "overwrite">();
    expectTypeOf<ImportPreviewItem>().toEqualTypeOf<{
      index: number;
      productCode: string;
      warnings?: string[];
      fieldErrors?: Record<string, string[]>;
    }>();
    expectTypeOf<ImportPreview>().toEqualTypeOf<{
      previewToken: string;
      expiresAt: string;
      creates: ImportPreviewItem[];
      conflicts: ImportPreviewItem[];
      invalid: ImportPreviewItem[];
      warnings: string[];
    }>();
    expectTypeOf<ImportReport>().toEqualTypeOf<{
      created: number;
      overwritten: number;
      skipped: number;
      invalid: number;
    }>();
    expectTypeOf<ExportDownload>().toEqualTypeOf<{ blob: Blob; filename: string }>();
  });
});

describe("previewImport", () => {
  it("uploads exactly one file field without manually setting Content-Type", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(preview));
    vi.stubGlobal("fetch", fetcher);
    const file = new File(["[]"], "android.json", { type: "application/json" });

    await expect(previewImport(file)).resolves.toEqual(preview);

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/v1/grid-trades/import/preview");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    const body = init.body as FormData;
    expect([...body.keys()]).toEqual(["file"]);
    expect(body.getAll("file")).toEqual([file]);
    const headers = new Headers(init.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.has("Content-Type")).toBe(false);
  });
});

describe("commitImport", () => {
  it("posts the exact preview token and conflict policy as JSON", async () => {
    const report: ImportReport = { created: 2, overwritten: 1, skipped: 0, invalid: 3 };
    const fetcher = vi.fn().mockResolvedValue(Response.json(report));
    vi.stubGlobal("fetch", fetcher);

    await expect(commitImport("preview-token", "overwrite")).resolves.toEqual(report);

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/grid-trades/import/commit",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ previewToken: "preview-token", conflictPolicy: "overwrite" }),
      }),
    );
    const init = fetcher.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Accept")).toBe("application/json");
  });
});

describe("downloadExport", () => {
  it.each(["android", "web"] as const)(
    "downloads the raw %s response once from the matching format endpoint",
    async (format) => {
      const response = new Response(`export-${format}`, {
        headers: {
          "content-disposition": `attachment; filename="fitgridweb-${format}-2026-09-02.json"`,
          "content-type": "application/json",
        },
      });
      const blob = vi.spyOn(response, "blob");
      const fetcher = vi.fn().mockResolvedValue(response);
      vi.stubGlobal("fetch", fetcher);

      const result = await downloadExport(format);

      expect(fetcher).toHaveBeenCalledWith(
        `/api/v1/grid-trades/export?format=${format}`,
        expect.objectContaining({ credentials: "same-origin" }),
      );
      expect(blob).toHaveBeenCalledTimes(1);
      expect(result.filename).toBe(`fitgridweb-${format}-2026-09-02.json`);
      await expect(result.blob.text()).resolves.toBe(`export-${format}`);
    },
  );

  it("accepts a safe unquoted ASCII filename parameter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", {
      headers: { "content-disposition": "attachment; filename=fitgridweb-web-2026-09-02.json" },
    })));

    await expect(downloadExport("web")).resolves.toMatchObject({
      filename: "fitgridweb-web-2026-09-02.json",
    });
  });

  it.each([
    ["a missing header", undefined],
    ["path traversal", "attachment; filename=\"../fitgridweb-web-2026-09-02.json\""],
    ["a path separator", "attachment; filename=\"folder\\\\fitgridweb-web-2026-09-02.json\""],
    ["a control character", "attachment; filename=\"fitgridweb-web-2026-09-02.json\u0001\""],
    ["an arbitrary extension", "attachment; filename=\"fitgridweb-web-2026-09-02.exe\""],
    ["an RFC5987 filename", "attachment; filename*=UTF-8''fitgridweb-web-2026-09-02.json"],
    [
      "an RFC5987 override beside a safe filename",
      "attachment; filename=\"fitgridweb-web-2026-09-02.json\"; filename*=UTF-8''surprise.json",
    ],
    ["a filename for the other format", "attachment; filename=\"fitgridweb-android-2026-09-02.json\""],
  ])("uses the requested-format fallback for %s", async (_case, contentDisposition) => {
    const headers = contentDisposition ? { "content-disposition": contentDisposition } : undefined;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { headers })));

    await expect(downloadExport("web")).resolves.toMatchObject({ filename: "fitgridweb-web.json" });
  });
});
