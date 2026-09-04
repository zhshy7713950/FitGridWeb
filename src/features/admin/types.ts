export type ManagedUser = {
  id: string;
  username: string;
  role: "member" | "admin";
  status: "active" | "disabled";
  createdAt: string;
};

export type ManagedUserPage = {
  items: ManagedUser[];
  nextCursor: string | null;
};

export type CreatedInvitation = {
  id: string;
  inviteUrl: string;
  expiresAt: string;
};

export type MaintenanceState =
  | "queued"
  | "dumping"
  | "encrypting"
  | "ready"
  | "uploading"
  | "inspecting"
  | "awaiting-confirmation"
  | "snapshotting"
  | "restoring"
  | "migrating"
  | "checking"
  | "succeeded"
  | "failed"
  | "rollback"
  | "intervention-required";

export type MaintenanceJobType = "backup" | "inspect-restore" | "restore";

export type QueuedMaintenanceJob = {
  id: string;
  type: MaintenanceJobType;
  state: "queued";
  requestId: string;
};

export type RestorePreview = {
  users: number;
  gridTrades: number;
  invitations: number;
  importPreviews: number;
};

export type MaintenanceJobStatus = {
  id: string;
  type: MaintenanceJobType;
  state: MaintenanceState;
  requestId: string;
  updatedAt: string;
  code?: string;
  rolledBack?: boolean;
  expiresAt?: number;
  backupCreatedAt?: string;
  postgresMajor?: number;
  database?: string;
  preview?: RestorePreview;
};

export type PortableBackupSummary = {
  id: string;
  createdAt: string;
  size: number;
  sha256: string;
};

export type PortableBackupList = {
  items: PortableBackupSummary[];
};

export type CreatePortableBackupInput = {
  currentPassword: string;
  backupPassword: string;
  confirmBackupPassword: string;
};

export type ConfirmRestoreInput = {
  currentPassword: string;
  confirmationPhrase: "恢复全部数据";
};
