import { requestJson, requestResponse } from "@/lib/api-client";

import type {
  ExportDownload,
  ImportConflictPolicy,
  ImportPreview,
  ImportReport,
} from "./types";

type ExportFormat = "android" | "web";

const EXPORT_FILENAME = /^fitgridweb-(android|web)-\d{4}-\d{2}-\d{2}\.json$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function exportFilename(contentDisposition: string | null, format: ExportFormat): string {
  const fallback = `fitgridweb-${format}.json`;
  if (
    !contentDisposition ||
    CONTROL_CHARACTER.test(contentDisposition) ||
    contentDisposition.includes(",")
  ) return fallback;

  const parts = contentDisposition.split(";");
  if (parts.shift()?.trim().toLowerCase() !== "attachment") return fallback;
  const filenameParts = parts.filter((part) => /^\s*filename\b/i.test(part));
  if (
    filenameParts.length !== 1 ||
    /^\s*filename\s*\*/i.test(filenameParts[0])
  ) return fallback;

  const parsedFilename = filenameParts[0].match(
    /^\s*filename\s*=\s*(?:"([^"]*)"|([^"\s;]+))\s*$/i,
  );
  if (!parsedFilename) return fallback;

  const filename = parsedFilename[1] ?? parsedFilename[2];
  const match = filename.match(EXPORT_FILENAME);
  return match?.[1] === format ? filename : fallback;
}

export async function previewImport(file: File): Promise<ImportPreview> {
  const body = new FormData();
  body.append("file", file);
  return requestJson<ImportPreview>("/grid-trades/import/preview", { method: "POST", body });
}

export function commitImport(
  previewToken: string,
  conflictPolicy: ImportConflictPolicy,
): Promise<ImportReport> {
  return requestJson<ImportReport>("/grid-trades/import/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ previewToken, conflictPolicy }),
  });
}

export async function downloadExport(format: ExportFormat): Promise<ExportDownload> {
  const response = await requestResponse(`/grid-trades/export?format=${format}`);
  const filename = exportFilename(response.headers.get("Content-Disposition"), format);
  const blob = await response.blob();
  return { blob, filename };
}
