import type { ImportPreview } from "./types";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

export function validateImportFile(file: File): string | null {
  if (!/\.json$/i.test(file.name)) return "请选择 JSON 文件";
  if (file.size === 0) return "导入文件不能为空";
  if (file.size > MAX_IMPORT_BYTES) return "导入文件不能超过 10 MiB";
  return null;
}

export function isPreviewExpired(
  preview: Pick<ImportPreview, "expiresAt">,
  now: Date = new Date(),
): boolean {
  const expiresAt = Date.parse(preview.expiresAt);
  const currentTime = now.getTime();
  if (!Number.isFinite(expiresAt) || !Number.isFinite(currentTime)) return true;
  return currentTime >= expiresAt;
}
