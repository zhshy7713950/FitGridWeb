import { ClientApiError } from "@/lib/api-client";

import type {
  ConfirmRestoreInput,
  CreatePortableBackupInput,
  MaintenanceJobStatus,
  MaintenanceState,
  PortableBackupList,
  PortableBackupSummary,
  QueuedMaintenanceJob,
} from "./types";

const demoArchiveUrl = "data:application/vnd.fitgrid.backup;base64,Rml0R3JpZCBVSSBkZW1vIGFyY2hpdmU=";

type DemoJob = {
  cursor: number;
  statuses: MaintenanceJobStatus[];
  publishedBackup?: PortableBackupSummary;
};

let backups: PortableBackupSummary[] = [];
let jobs = new Map<string, DemoJob>();
let backupSequence = 0;
let inspectionSequence = 0;
let restoreSequence = 0;

function assertActive(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function validationError(message: string, requestId: string): ClientApiError {
  return new ClientApiError(422, "VALIDATION_FAILED", message, requestId);
}

function missingJob(): ClientApiError {
  return new ClientApiError(
    404,
    "MAINTENANCE_JOB_NOT_FOUND",
    "维护任务不存在",
    "demo-maintenance-job-not-found",
  );
}

function immutableStatus(status: MaintenanceJobStatus): MaintenanceJobStatus {
  return Object.freeze({
    ...status,
    preview: status.preview ? Object.freeze({ ...status.preview }) : undefined,
  });
}

function statusesFor(
  id: string,
  type: MaintenanceJobStatus["type"],
  requestId: string,
  states: MaintenanceState[],
  details: Partial<MaintenanceJobStatus> = {},
): MaintenanceJobStatus[] {
  return states.map((state, index) => immutableStatus({
    id,
    type,
    state,
    requestId,
    updatedAt: new Date(Date.UTC(2026, 8, 3, 8, 0, index + 1)).toISOString(),
    ...(state === states.at(-1) ? details : {}),
  }));
}

function passwordHasValidLength(value: string): boolean {
  const length = Array.from(value).length;
  return length >= 12 && length <= 128;
}

function reset(): void {
  backups = [
    {
      id: "demo-portable-backup-02",
      createdAt: "2026-09-02T08:00:00.000Z",
      size: 13_107_200,
      sha256: "2".repeat(64),
    },
    {
      id: "demo-portable-backup-01",
      createdAt: "2026-09-01T08:00:00.000Z",
      size: 12_582_912,
      sha256: "1".repeat(64),
    },
  ];
  jobs = new Map();
  backupSequence = 0;
  inspectionSequence = 0;
  restoreSequence = 0;
}

export function resetDemoMaintenanceDataForTests(): void {
  reset();
}

reset();

export function listDemoPortableBackups(signal?: AbortSignal): PortableBackupList {
  assertActive(signal);
  return { items: backups.slice(0, 5).map((backup) => ({ ...backup })) };
}

export function createDemoPortableBackup(
  input: CreatePortableBackupInput,
  signal?: AbortSignal,
): QueuedMaintenanceJob {
  assertActive(signal);
  if (!input.currentPassword) {
    throw validationError("请输入当前管理员密码", "demo-backup-current-password");
  }
  if (!passwordHasValidLength(input.backupPassword)) {
    throw validationError("备份密码必须包含 12–128 个字符", "demo-backup-password-length");
  }
  if (input.backupPassword !== input.confirmBackupPassword) {
    throw validationError("两次输入的备份密码不一致", "demo-backup-password-match");
  }

  backupSequence += 1;
  const suffix = String(backupSequence).padStart(12, "0");
  const id = `10000000-0000-4000-8000-${suffix}`;
  const requestId = `demo-backup-job-${String(backupSequence).padStart(2, "0")}`;
  const createdAt = new Date(Date.UTC(2026, 8, 3, 8, backupSequence - 1)).toISOString();
  const publishedBackup = {
    id: `demo-portable-backup-${String(backupSequence + 2).padStart(2, "0")}`,
    createdAt,
    size: 13_631_488 + backupSequence * 524_288,
    sha256: ((backupSequence + 2) % 16).toString(16).repeat(64),
  } satisfies PortableBackupSummary;
  jobs.set(id, {
    cursor: 0,
    statuses: statusesFor(id, "backup", requestId, ["dumping", "encrypting", "ready"]),
    publishedBackup,
  });
  return Object.freeze({ id, type: "backup", state: "queued", requestId });
}

export function getDemoMaintenanceJob(
  jobId: string,
  signal?: AbortSignal,
): MaintenanceJobStatus {
  assertActive(signal);
  const job = jobs.get(jobId);
  if (!job) throw missingJob();
  const index = Math.min(job.cursor, job.statuses.length - 1);
  const status = job.statuses[index];
  job.cursor += 1;
  if (status.state === "ready" && job.publishedBackup) {
    backups = [job.publishedBackup, ...backups]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 5);
    job.publishedBackup = undefined;
  }
  return status;
}

export function issueDemoBackupDownload(
  backupId: string,
  signal?: AbortSignal,
): string {
  assertActive(signal);
  if (!backups.some((backup) => backup.id === backupId)) {
    throw new ClientApiError(
      404,
      "BACKUP_NOT_FOUND",
      "备份不存在",
      "demo-backup-not-found",
    );
  }
  return `${demoArchiveUrl}#${encodeURIComponent(backupId)}`;
}

export function uploadDemoRestoreForInspection(
  file: File,
  passphrase: string,
  signal?: AbortSignal,
): QueuedMaintenanceJob {
  assertActive(signal);
  if (!/^fitgridweb-[0-9]{8}T[0-9]{6}Z\.fitgridbackup$/.test(file.name)) {
    throw validationError("请选择有效的 .fitgridbackup 文件", "demo-restore-file-name");
  }
  if (!passwordHasValidLength(passphrase)) {
    throw validationError("备份密码必须包含 12–128 个字符", "demo-restore-password-length");
  }

  inspectionSequence += 1;
  const suffix = String(inspectionSequence).padStart(12, "0");
  const id = `20000000-0000-4000-8000-${suffix}`;
  const requestId = `demo-inspection-job-${String(inspectionSequence).padStart(2, "0")}`;
  jobs.set(id, {
    cursor: 0,
    statuses: statusesFor(
      id,
      "inspect-restore",
      requestId,
      ["uploading", "inspecting", "awaiting-confirmation"],
      {
        backupCreatedAt: "2026-09-03T06:30:00.000Z",
        postgresMajor: 17,
        database: "fitgridweb",
        expiresAt: 1_788_418_200,
        preview: { users: 3, gridTrades: 24, invitations: 2, importPreviews: 1 },
      },
    ),
  });
  return Object.freeze({ id, type: "inspect-restore", state: "queued", requestId });
}

export function confirmDemoRestore(
  restoreId: string,
  input: ConfirmRestoreInput,
  signal?: AbortSignal,
): QueuedMaintenanceJob {
  assertActive(signal);
  const inspection = jobs.get(restoreId);
  const inspectedStatus = inspection?.statuses[Math.min(
    Math.max(inspection.cursor - 1, 0),
    inspection.statuses.length - 1,
  )];
  if (inspectedStatus?.state !== "awaiting-confirmation") throw missingJob();
  if (!input.currentPassword) {
    throw validationError("请输入当前管理员密码", "demo-restore-current-password");
  }
  if (input.confirmationPhrase !== "恢复全部数据") {
    throw validationError("请输入完整确认短语", "demo-restore-confirmation-phrase");
  }

  restoreSequence += 1;
  const suffix = String(restoreSequence).padStart(12, "0");
  const id = `30000000-0000-4000-8000-${suffix}`;
  const requestId = `demo-restore-job-${String(restoreSequence).padStart(2, "0")}`;
  jobs.set(id, {
    cursor: 0,
    statuses: statusesFor(id, "restore", requestId, ["restoring", "checking", "succeeded"]),
  });
  return Object.freeze({ id, type: "restore", state: "queued", requestId });
}

export function checkDemoMaintenanceHealth(signal?: AbortSignal): boolean {
  assertActive(signal);
  return true;
}
