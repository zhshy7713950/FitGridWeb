import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readdir,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

import {
  type ConfirmRestoreInput,
  type CreateBackupInput,
  type MaintenanceGateway,
  type MaintenanceJobStatus,
  type MaintenanceMode,
  maintenanceRequestIdSchema,
  maintenanceStateSchema,
  maintenanceUuidSchema,
  type PortableBackupFile,
  portableBackupFilenameSchema,
  portableBackupIdSchema,
  type PortableBackupSummary,
  type QueuedMaintenanceJob,
  type WriteUploadInput,
} from "./types";

const terminalStates = new Set(["ready", "awaiting-confirmation", "succeeded", "failed", "intervention-required"]);
const jobTypeSchema = z.enum(["backup", "inspect-restore", "restore"]);
const isoDateSchema = z.iso.datetime({ offset: true });
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const previewSchema = z.strictObject({
  users: z.number().int().nonnegative(),
  gridTrades: z.number().int().nonnegative(),
  invitations: z.number().int().nonnegative(),
  importPreviews: z.number().int().nonnegative(),
});

const diskStatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: maintenanceUuidSchema,
  type: jobTypeSchema,
  actorId: maintenanceUuidSchema,
  requestId: maintenanceRequestIdSchema,
  state: maintenanceStateSchema,
  updatedAt: isoDateSchema,
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  rolledBack: z.boolean().optional(),
  expiresAt: z.number().int().safe().optional(),
  backupCreatedAt: isoDateSchema.optional(),
  appImage: z.string().min(1).max(255).optional(),
  postgresMajor: z.number().int().positive().max(999).optional(),
  database: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  preview: previewSchema.optional(),
}).superRefine((value, context) => {
  const allowedStates = {
    backup: new Set(["queued", "dumping", "encrypting", "ready", "failed", "intervention-required"]),
    "inspect-restore": new Set(["queued", "uploading", "inspecting", "awaiting-confirmation", "failed", "intervention-required"]),
    restore: new Set(["queued", "snapshotting", "restoring", "migrating", "checking", "succeeded", "failed", "rollback", "intervention-required"]),
  } as const;
  if (!allowedStates[value.type].has(value.state as never)) {
    context.addIssue({ code: "custom", message: "invalid state for maintenance operation" });
  }
  const previewKeys = ["expiresAt", "backupCreatedAt", "appImage", "postgresMajor", "database", "preview"] as const;
  const present = previewKeys.filter((key) => value[key] !== undefined).length;
  if (
    (present !== 0 && (value.type !== "inspect-restore" || value.state !== "awaiting-confirmation" || present !== previewKeys.length))
    || (value.state === "awaiting-confirmation" && present !== previewKeys.length)
  ) {
    context.addIssue({ code: "custom", message: "invalid restore preview status" });
  }
});

const markerSchema = z.union([
  z.strictObject({
    schemaVersion: z.literal(1),
    active: z.literal(true),
    jobId: maintenanceUuidSchema,
    updatedAt: isoDateSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    active: z.literal(false),
    updatedAt: isoDateSchema,
  }),
]);
const admissionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: maintenanceUuidSchema,
  createdAt: isoDateSchema,
});

const historyEntrySchema = z.strictObject({
  id: portableBackupIdSchema,
  filename: portableBackupFilenameSchema,
  createdAt: isoDateSchema,
  size: z.number().int().nonnegative().safe(),
  sha256: digestSchema,
  status: z.string().min(1).max(32),
});
const historySchema = z.strictObject({ entries: z.array(historyEntrySchema).max(10_000) });

type DiskStatus = z.infer<typeof diskStatusSchema>;

export interface FileMaintenanceGatewayConfiguration {
  adminOpsDirectory: string;
  portableBackupDirectory: string;
  portableBackupHistoryFile: string;
  maxUploadBytes: number;
  idGenerator?: () => string;
  clock?: () => number;
}

function stateInvalid(): ApiError {
  return new ApiError(500, "MAINTENANCE_STATE_INVALID", "维护状态暂时不可用");
}

function notFound(): ApiError {
  return new ApiError(404, "MAINTENANCE_NOT_FOUND", "维护任务或备份不存在");
}

function busy(): ApiError {
  return new ApiError(409, "MAINTENANCE_BUSY", "已有维护任务正在执行");
}

function safeInput<T>(schema: z.ZodType<T>, value: unknown, missing = notFound): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw missing();
  return parsed.data;
}

function validatePassphrase(passphrase: string): void {
  const length = Array.from(passphrase).length;
  if (length < 12 || length > 128 || /[\n\r\0]/.test(passphrase)) {
    throw new ApiError(422, "BACKUP_PASSPHRASE_INVALID", "备份密码必须包含 12–128 个字符");
  }
}

async function requireDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== path.resolve(directory)) {
      throw stateInvalid();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw stateInvalid();
  }
}

async function readValidatedJson<T>(
  filePath: string,
  schema: z.ZodType<T>,
  options: { missing?: "null" | "not-found"; maxBytes?: number } = {},
): Promise<T | null> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > (options.maxBytes ?? 256 * 1024)) throw stateInvalid();
    const text = await handle.readFile({ encoding: "utf8" });
    return schema.parse(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (options.missing === "null") return null;
      throw notFound();
    }
    if (error instanceof ApiError) throw error;
    throw stateInvalid();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeExclusive(filePath: string, contents: string | Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishJsonNoReplace(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  const target = path.join(directory, name);
  let targetPublished = false;
  try {
    await writeExclusive(temporary, `${JSON.stringify(value)}\n`);
    await link(temporary, target);
    targetPublished = true;
    await syncDirectory(directory);
  } catch (error) {
    if (targetPublished) await unlink(target).catch(() => undefined);
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function publicStatus(status: DiskStatus): MaintenanceJobStatus {
  return {
    id: status.id,
    type: status.type,
    requestId: status.requestId,
    state: status.state,
    updatedAt: status.updatedAt,
    ...(status.code ? { code: status.code } : {}),
    ...(status.rolledBack !== undefined ? { rolledBack: status.rolledBack } : {}),
    ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
    ...(status.backupCreatedAt ? { backupCreatedAt: status.backupCreatedAt } : {}),
    ...(status.appImage ? { appImage: status.appImage } : {}),
    ...(status.postgresMajor !== undefined ? { postgresMajor: status.postgresMajor } : {}),
    ...(status.database ? { database: status.database } : {}),
    ...(status.preview ? { preview: status.preview } : {}),
  };
}

export class FileMaintenanceGateway implements MaintenanceGateway {
  private readonly inbox: string;
  private readonly uploads: string;
  private readonly statusDirectory: string;
  private readonly idGenerator: () => string;
  private readonly clock: () => number;

  constructor(private readonly configuration: FileMaintenanceGatewayConfiguration) {
    if (
      !path.isAbsolute(configuration.adminOpsDirectory)
      || !path.isAbsolute(configuration.portableBackupDirectory)
      || configuration.portableBackupHistoryFile !== path.join(configuration.adminOpsDirectory, "status", "backups.json")
      || !Number.isSafeInteger(configuration.maxUploadBytes)
      || configuration.maxUploadBytes <= 0
    ) throw stateInvalid();
    this.inbox = path.join(configuration.adminOpsDirectory, "inbox");
    this.uploads = path.join(configuration.adminOpsDirectory, "uploads");
    this.statusDirectory = path.join(configuration.adminOpsDirectory, "status");
    this.idGenerator = configuration.idGenerator ?? randomUUID;
    this.clock = configuration.clock ?? Date.now;
  }

  private async requireSpool(includeBackups = false): Promise<void> {
    await requireDirectory(this.configuration.adminOpsDirectory);
    await requireDirectory(this.inbox);
    await requireDirectory(this.uploads);
    await requireDirectory(this.statusDirectory);
    if (includeBackups) await requireDirectory(this.configuration.portableBackupDirectory);
  }

  private validateIdentity(actorId: string, requestId: string): void {
    safeInput(maintenanceUuidSchema, actorId);
    safeInput(maintenanceRequestIdSchema, requestId);
  }

  private nextId(): string {
    return safeInput(maintenanceUuidSchema, this.idGenerator(), stateInvalid);
  }

  private async acquireSubmissionLock(): Promise<() => Promise<void>> {
    const lockDirectory = path.join(this.inbox, ".submission-lock");
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw busy();
      throw stateInvalid();
    }
    return () => rmdir(lockDirectory).catch(() => undefined);
  }

  private async assertIdle(): Promise<void> {
    const admissionPath = path.join(this.statusDirectory, "active-job.json");
    const admission = await readValidatedJson(admissionPath, admissionSchema, { missing: "null" });
    if (admission) {
      const admittedStatus = await readValidatedJson(
        path.join(this.statusDirectory, `${admission.jobId}.json`),
        diskStatusSchema,
        { missing: "null" },
      );
      if (!admittedStatus || admittedStatus.id !== admission.jobId || !terminalStates.has(admittedStatus.state)) {
        throw busy();
      }
      await unlink(admissionPath).catch(() => { throw stateInvalid(); });
      await syncDirectory(this.statusDirectory).catch(() => { throw stateInvalid(); });
    }

    const marker = await readValidatedJson(
      path.join(this.statusDirectory, "maintenance.json"),
      markerSchema,
      { missing: "null" },
    );
    if (marker?.active) throw busy();

    const inboxNames = await readdir(this.inbox).catch(() => { throw stateInvalid(); });
    if (inboxNames.some((name) => /^[0-9a-f-]{36}\.json$/.test(name))) throw busy();

    const statusNames = await readdir(this.statusDirectory).catch(() => { throw stateInvalid(); });
    for (const name of statusNames) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const value = await readValidatedJson(path.join(this.statusDirectory, name), diskStatusSchema);
      if (value && !terminalStates.has(value.state)) throw busy();
    }
  }

  private async submit(
    job: Record<string, unknown> & { id: string },
    cleanup: string[],
  ): Promise<void> {
    const admission = path.join(this.statusDirectory, "active-job.json");
    let admissionPublished = false;
    try {
      await publishJsonNoReplace(this.statusDirectory, "active-job.json", {
        schemaVersion: 1,
        jobId: job.id,
        createdAt: new Date(this.clock()).toISOString(),
      });
      admissionPublished = true;
      await publishJsonNoReplace(this.inbox, `${job.id}.json`, job);
    } catch (error) {
      await Promise.all([
        ...cleanup,
        ...(admissionPublished ? [admission] : []),
      ].map((file) => unlink(file).catch(() => undefined)));
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw busy();
      throw stateInvalid();
    }
  }

  async createBackup(input: CreateBackupInput): Promise<QueuedMaintenanceJob> {
    this.validateIdentity(input.actorId, input.requestId);
    validatePassphrase(input.passphrase);
    await this.requireSpool();
    const release = await this.acquireSubmissionLock();
    try {
      await this.assertIdle();
      const id = this.nextId();
      const secret = path.join(this.inbox, `${id}.secret`);
      try {
        await writeExclusive(secret, input.passphrase);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw busy();
        throw stateInvalid();
      }
      await this.submit({
        schemaVersion: 1,
        id,
        type: "backup",
        actorId: input.actorId,
        requestId: input.requestId,
      }, [secret]);
      return { id, type: "backup", state: "queued", requestId: input.requestId };
    } finally {
      await release();
    }
  }

  async writeUpload(
    input: WriteUploadInput,
    stream: ReadableStream<Uint8Array>,
  ): Promise<QueuedMaintenanceJob> {
    this.validateIdentity(input.actorId, input.requestId);
    validatePassphrase(input.passphrase);
    safeInput(portableBackupFilenameSchema, input.fileName);
    if (!Number.isSafeInteger(input.size) || input.size <= 0) {
      throw new ApiError(422, "BACKUP_SIZE_INVALID", "备份大小无效");
    }
    if (input.size > this.configuration.maxUploadBytes) {
      throw new ApiError(413, "BACKUP_TOO_LARGE", "备份文件超过大小限制");
    }
    const id = this.nextId();
    await this.requireSpool();
    const release = await this.acquireSubmissionLock();
    const upload = path.join(this.uploads, `${id}.fitgridbackup`);
    const secret = path.join(this.inbox, `${id}.secret`);
    let handle;
    let uploadCreated = false;
    let secretCreated = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      reader = stream.getReader();
      await this.assertIdle();
      handle = await open(
        upload,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      uploadCreated = true;
      let bytes = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) throw new ApiError(422, "BACKUP_STREAM_INVALID", "备份上传流无效");
        bytes += result.value.byteLength;
        if (bytes > input.size || bytes > this.configuration.maxUploadBytes) {
          throw new ApiError(
            bytes > this.configuration.maxUploadBytes ? 413 : 422,
            bytes > this.configuration.maxUploadBytes ? "BACKUP_TOO_LARGE" : "BACKUP_SIZE_MISMATCH",
            bytes > this.configuration.maxUploadBytes ? "备份文件超过大小限制" : "备份实际大小与声明不一致",
          );
        }
        await handle.writeFile(result.value);
      }
      if (bytes !== input.size) {
        throw new ApiError(422, "BACKUP_SIZE_MISMATCH", "备份实际大小与声明不一致");
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(this.uploads);
      await writeExclusive(secret, input.passphrase);
      secretCreated = true;
      await syncDirectory(this.inbox);
      await this.submit({
        schemaVersion: 1,
        id,
        type: "inspect-restore",
        actorId: input.actorId,
        requestId: input.requestId,
      }, [upload, secret]);
      return { id, type: "inspect-restore", state: "queued", requestId: input.requestId };
    } catch (error) {
      await reader?.cancel().catch(() => undefined);
      await handle?.close().catch(() => undefined);
      await Promise.all([
        ...(uploadCreated ? [upload] : []),
        ...(secretCreated ? [secret] : []),
      ].map((file) => unlink(file).catch(() => undefined)));
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw busy();
      throw error;
    } finally {
      reader?.releaseLock();
      await release();
    }
  }

  async confirmRestore(input: ConfirmRestoreInput): Promise<QueuedMaintenanceJob> {
    this.validateIdentity(input.actorId, input.requestId);
    const restoreId = safeInput(maintenanceUuidSchema, input.restoreId);
    await this.requireSpool();
    const release = await this.acquireSubmissionLock();
    try {
      await this.assertIdle();
      const inspection = await this.readDiskStatus(restoreId);
      if (
        inspection.type !== "inspect-restore"
        || inspection.state !== "awaiting-confirmation"
        || inspection.actorId !== input.actorId
        || inspection.expiresAt === undefined
        || inspection.expiresAt <= Math.floor(this.clock() / 1_000)
      ) throw notFound();
      const id = this.nextId();
      await this.submit({
        schemaVersion: 1,
        id,
        type: "restore",
        actorId: input.actorId,
        requestId: input.requestId,
        restoreId,
      }, []);
      return { id, type: "restore", state: "queued", requestId: input.requestId };
    } finally {
      await release();
    }
  }

  private async readDiskStatus(jobId: string): Promise<DiskStatus> {
    const id = safeInput(maintenanceUuidSchema, jobId);
    const status = await readValidatedJson(path.join(this.statusDirectory, `${id}.json`), diskStatusSchema);
    if (!status || status.id !== id) throw stateInvalid();
    return status;
  }

  async getJob(jobId: string): Promise<MaintenanceJobStatus> {
    safeInput(maintenanceUuidSchema, jobId);
    await this.requireSpool();
    return publicStatus(await this.readDiskStatus(jobId));
  }

  async getMaintenanceMode(): Promise<MaintenanceMode | null> {
    await this.requireSpool();
    const marker = await readValidatedJson(
      path.join(this.statusDirectory, "maintenance.json"),
      markerSchema,
      { missing: "null" },
    );
    if (!marker) return null;
    return {
      active: marker.active,
      ...(marker.active ? { jobId: marker.jobId } : {}),
      updatedAt: marker.updatedAt,
    };
  }

  private async readableArchive(filename: string, expectedSize: number): Promise<boolean> {
    const archive = path.join(this.configuration.portableBackupDirectory, filename);
    try {
      const info = await lstat(archive);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedSize) return false;
      const resolved = await realpath(archive);
      return path.dirname(resolved) === path.resolve(this.configuration.portableBackupDirectory);
    } catch {
      return false;
    }
  }

  private async historyEntries(): Promise<z.infer<typeof historyEntrySchema>[]> {
    await this.requireSpool(true);
    const history = await readValidatedJson(
      this.configuration.portableBackupHistoryFile,
      historySchema,
      { missing: "null", maxBytes: 2 * 1024 * 1024 },
    );
    return history?.entries ?? [];
  }

  async listBackups(): Promise<PortableBackupSummary[]> {
    const entries = await this.historyEntries();
    const seen = new Set<string>();
    const result: PortableBackupSummary[] = [];
    for (const entry of [...entries].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
      if (entry.status !== "ready" || seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (!await this.readableArchive(entry.filename, entry.size)) continue;
      result.push({ id: entry.id, createdAt: entry.createdAt, size: entry.size, sha256: entry.sha256 });
      if (result.length === 5) break;
    }
    return result;
  }

  async getBackupFile(backupId: string): Promise<PortableBackupFile> {
    const id = safeInput(portableBackupIdSchema, backupId);
    const entry = (await this.historyEntries()).find((candidate) => candidate.id === id && candidate.status === "ready");
    if (!entry || !await this.readableArchive(entry.filename, entry.size)) throw notFound();
    return {
      id: entry.id,
      name: entry.filename,
      path: path.join(this.configuration.portableBackupDirectory, entry.filename),
      createdAt: entry.createdAt,
      size: entry.size,
      sha256: entry.sha256,
    };
  }
}
