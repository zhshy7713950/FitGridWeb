import { apiPath } from "@/lib/app-paths";
import { requestJson, requestResponse } from "@/lib/api-client";

import type {
  ConfirmRestoreInput,
  CreatePortableBackupInput,
  MaintenanceJobStatus,
  PortableBackupList,
  QueuedMaintenanceJob,
} from "./types";

const backupMediaType = "application/vnd.fitgrid.backup";

export function createPortableBackup(
  input: CreatePortableBackupInput,
  signal?: AbortSignal,
): Promise<QueuedMaintenanceJob> {
  return requestJson("/admin/backups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

export function listPortableBackups(signal?: AbortSignal): Promise<PortableBackupList> {
  return requestJson("/admin/backups", { signal });
}

export function getMaintenanceJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<MaintenanceJobStatus> {
  return requestJson(
    `/admin/maintenance/jobs/${encodeURIComponent(jobId)}`,
    { signal },
    () => undefined,
  );
}

export async function issueBackupDownload(
  backupId: string,
  signal?: AbortSignal,
): Promise<string> {
  const { token } = await requestJson<{ token: string }>(
    `/admin/backups/${encodeURIComponent(backupId)}/download-token`,
    { method: "POST", signal },
  );
  return apiPath(
    `/admin/backups/${encodeURIComponent(backupId)}/download?token=${encodeURIComponent(token)}`,
  );
}

export function uploadRestoreForInspection(
  file: File,
  passphrase: string,
  signal?: AbortSignal,
): Promise<QueuedMaintenanceJob> {
  const streamingRequest: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: {
      "Content-Type": backupMediaType,
      "X-FitGrid-Backup-Passphrase": passphrase,
      "X-FitGrid-Backup-Size": String(file.size),
    },
    body: file.stream(),
    signal,
    duplex: "half",
  };
  return requestJson(
    `/admin/restores/uploads?fileName=${encodeURIComponent(file.name)}`,
    streamingRequest,
  );
}

export function confirmRestore(
  restoreId: string,
  input: ConfirmRestoreInput,
  signal?: AbortSignal,
): Promise<QueuedMaintenanceJob> {
  return requestJson(`/admin/restores/${encodeURIComponent(restoreId)}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

export async function checkMaintenanceHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await requestResponse("/health", { signal });
    const body = await response.json() as { status?: string; database?: string };
    return body.status === "ok" && body.database === "ok";
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return false;
  }
}
