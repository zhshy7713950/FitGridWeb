import { apiPath } from "@/lib/app-paths";
import { requestJson, requestResponse } from "@/lib/api-client";
import { isUiDemoMode } from "@/lib/ui-demo";

import type {
  ConfirmRestoreInput,
  CreatePortableBackupInput,
  MaintenanceJobStatus,
  PortableBackupList,
  QueuedMaintenanceJob,
} from "./types";

const backupMediaType = "application/vnd.fitgrid.backup";

type DemoMaintenanceData = typeof import("./demo-maintenance-data");

const loadDemoMaintenanceData = process.env.NODE_ENV === "production"
  ? null
  : () => import("./demo-maintenance-data");

function demoMaintenanceData(): Promise<DemoMaintenanceData> {
  if (!loadDemoMaintenanceData) {
    return Promise.reject(new Error("UI demo maintenance data is unavailable in production"));
  }
  return loadDemoMaintenanceData();
}

export function createPortableBackup(
  input: CreatePortableBackupInput,
  signal?: AbortSignal,
): Promise<QueuedMaintenanceJob> {
  if (isUiDemoMode()) {
    return demoMaintenanceData().then((demo) => demo.createDemoPortableBackup(input, signal));
  }
  return requestJson("/admin/backups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

export function listPortableBackups(signal?: AbortSignal): Promise<PortableBackupList> {
  if (isUiDemoMode()) {
    return demoMaintenanceData().then((demo) => demo.listDemoPortableBackups(signal));
  }
  return requestJson("/admin/backups", { signal });
}

export function getMaintenanceJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<MaintenanceJobStatus> {
  if (isUiDemoMode()) {
    return demoMaintenanceData().then((demo) => demo.getDemoMaintenanceJob(jobId, signal));
  }
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
  if (isUiDemoMode()) {
    return demoMaintenanceData().then((demo) => demo.issueDemoBackupDownload(backupId, signal));
  }
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
  if (isUiDemoMode()) {
    return demoMaintenanceData().then((demo) => (
      demo.uploadDemoRestoreForInspection(file, passphrase, signal)
    ));
  }
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
  if (isUiDemoMode()) {
    return demoMaintenanceData().then((demo) => demo.confirmDemoRestore(restoreId, input, signal));
  }
  return requestJson(`/admin/restores/${encodeURIComponent(restoreId)}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}

export async function checkMaintenanceHealth(signal?: AbortSignal): Promise<boolean> {
  if (isUiDemoMode()) {
    return demoMaintenanceData().then((demo) => demo.checkDemoMaintenanceHealth(signal));
  }
  try {
    const response = await requestResponse("/health", { signal });
    const body = await response.json() as { status?: string; database?: string };
    return body.status === "ok" && body.database === "ok";
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return false;
  }
}
