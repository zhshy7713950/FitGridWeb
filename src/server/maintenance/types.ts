import { z } from "zod";

export const maintenanceUuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
export const maintenanceRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const portableBackupIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9.][A-Za-z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..");
export const portableBackupFilenameSchema = z.string().regex(
  /^fitgridweb-[0-9]{8}T[0-9]{6}Z\.fitgridbackup$/,
);

export const maintenanceStateSchema = z.enum([
  "queued",
  "dumping",
  "encrypting",
  "ready",
  "uploading",
  "inspecting",
  "awaiting-confirmation",
  "snapshotting",
  "restoring",
  "migrating",
  "checking",
  "succeeded",
  "failed",
  "rollback",
  "intervention-required",
]);

export type MaintenanceState = z.infer<typeof maintenanceStateSchema>;
export type MaintenanceJobType = "backup" | "inspect-restore" | "restore";

export interface QueuedMaintenanceJob {
  id: string;
  type: MaintenanceJobType;
  state: "queued";
  requestId: string;
}

export interface RestorePreview {
  users: number;
  gridTrades: number;
  invitations: number;
  importPreviews: number;
}

export interface MaintenanceJobStatus {
  id: string;
  type: MaintenanceJobType;
  requestId: string;
  state: MaintenanceState;
  updatedAt: string;
  code?: string;
  rolledBack?: boolean;
  expiresAt?: number;
  backupCreatedAt?: string;
  postgresMajor?: number;
  database?: string;
  preview?: RestorePreview;
}

export interface PortableBackupSummary {
  id: string;
  createdAt: string;
  size: number;
  sha256: string;
}

export interface PortableBackupFile extends PortableBackupSummary {
  name: string;
  path: string;
}

export interface MaintenanceMode {
  active: boolean;
  jobId?: string;
  updatedAt: string;
}

export interface CreateBackupInput {
  actorId: string;
  requestId: string;
  passphrase: string;
}

export interface WriteUploadInput extends CreateBackupInput {
  fileName: string;
  size: number;
}

export interface ConfirmRestoreInput {
  actorId: string;
  requestId: string;
  restoreId: string;
}

export interface MaintenanceGateway {
  createBackup(input: CreateBackupInput): Promise<QueuedMaintenanceJob>;
  writeUpload(
    input: WriteUploadInput,
    stream: ReadableStream<Uint8Array>,
  ): Promise<QueuedMaintenanceJob>;
  confirmRestore(input: ConfirmRestoreInput): Promise<QueuedMaintenanceJob>;
  getJob(jobId: string): Promise<MaintenanceJobStatus>;
  getMaintenanceMode(): Promise<MaintenanceMode | null>;
  listBackups(): Promise<PortableBackupSummary[]>;
  getBackupFile(backupId: string): Promise<PortableBackupFile>;
}
