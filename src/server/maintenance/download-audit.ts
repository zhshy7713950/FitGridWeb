import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

import {
  maintenanceRequestIdSchema,
  maintenanceUuidSchema,
  portableBackupIdSchema,
} from "./types";

const auditEventSchema = z.enum(["download-token-issued", "download-completed"]);
const auditRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: maintenanceUuidSchema,
  event: auditEventSchema,
  actorId: maintenanceUuidSchema,
  requestId: maintenanceRequestIdSchema,
  backupId: portableBackupIdSchema,
});
const auditAcknowledgmentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: maintenanceUuidSchema,
  state: z.literal("persisted"),
  expiresAt: z.number().int().safe().positive(),
});

export interface DownloadAuditInput {
  event: z.infer<typeof auditEventSchema>;
  actorId: string;
  requestId: string;
  backupId: string;
}

export interface DownloadAuditGateway {
  persist(input: DownloadAuditInput): Promise<void>;
}

export interface FileDownloadAuditGatewayConfiguration {
  adminOpsDirectory: string;
  idGenerator?: () => string;
  acknowledgmentTimeoutMs?: number;
  pollIntervalMs?: number;
  acknowledgmentUid?: number;
}

function stateInvalid(): ApiError {
  return new ApiError(500, "DOWNLOAD_AUDIT_STATE_INVALID", "下载审计状态暂时不可用");
}

function unavailable(): ApiError {
  return new ApiError(503, "DOWNLOAD_AUDIT_UNAVAILABLE", "下载审计暂时不可用");
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

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isDirectory()) throw stateInvalid();
    await handle.sync();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw stateInvalid();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeExclusive(filePath: string, contents: string): Promise<void> {
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

async function publishRequest(inbox: string, id: string, contents: string): Promise<void> {
  const temporary = path.join(inbox, `.${id}.${randomUUID()}.tmp`);
  const target = path.join(inbox, `${id}.audit`);
  let linked = false;
  try {
    await writeExclusive(temporary, contents);
    await link(temporary, target);
    linked = true;
    await syncDirectory(inbox).catch(() => undefined);
  } catch {
    if (!linked) throw stateInvalid();
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function readAcknowledgment(
  filePath: string,
  id: string,
  acknowledgmentUid: number,
): Promise<"missing" | "persisted"> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !info.isFile()
      || info.uid !== acknowledgmentUid
      || info.size > 1_024
      || (info.mode & 0o777) !== 0o640
    ) throw stateInvalid();
    const parsed = auditAcknowledgmentSchema.safeParse(JSON.parse(await handle.readFile("utf8")));
    if (
      !parsed.success
      || parsed.data.id !== id
      || parsed.data.expiresAt <= Math.floor(Date.now() / 1_000)
    ) throw stateInvalid();
    return "persisted";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    if (error instanceof ApiError) throw error;
    throw stateInvalid();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class FileDownloadAuditGateway implements DownloadAuditGateway {
  private readonly inbox: string;
  private readonly statusDirectory: string;
  private readonly idGenerator: () => string;
  private readonly acknowledgmentTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly acknowledgmentUid: number;

  constructor(configuration: FileDownloadAuditGatewayConfiguration) {
    const acknowledgmentTimeoutMs = configuration.acknowledgmentTimeoutMs ?? 10_000;
    const pollIntervalMs = configuration.pollIntervalMs ?? 25;
    const acknowledgmentUid = configuration.acknowledgmentUid ?? 0;
    if (
      !path.isAbsolute(configuration.adminOpsDirectory)
      || !Number.isSafeInteger(acknowledgmentTimeoutMs)
      || acknowledgmentTimeoutMs < 1
      || acknowledgmentTimeoutMs > 30_000
      || !Number.isSafeInteger(pollIntervalMs)
      || pollIntervalMs < 1
      || pollIntervalMs > acknowledgmentTimeoutMs
      || !Number.isSafeInteger(acknowledgmentUid)
      || acknowledgmentUid < 0
    ) throw stateInvalid();
    this.inbox = path.join(configuration.adminOpsDirectory, "inbox");
    this.statusDirectory = path.join(configuration.adminOpsDirectory, "status");
    this.idGenerator = configuration.idGenerator ?? randomUUID;
    this.acknowledgmentTimeoutMs = acknowledgmentTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.acknowledgmentUid = acknowledgmentUid;
  }

  async persist(input: DownloadAuditInput): Promise<void> {
    const id = maintenanceUuidSchema.safeParse(this.idGenerator());
    const request = auditRequestSchema.safeParse({
      schemaVersion: 1,
      id: id.success ? id.data : "",
      event: input.event,
      actorId: input.actorId,
      requestId: input.requestId,
      backupId: input.backupId,
    });
    if (!request.success) throw stateInvalid();
    await requireDirectory(this.inbox);
    await requireDirectory(this.statusDirectory);

    const acknowledgment = path.join(this.statusDirectory, `${request.data.id}.audit`);
    if (
      await readAcknowledgment(acknowledgment, request.data.id, this.acknowledgmentUid) !== "missing"
    ) throw stateInvalid();
    await publishRequest(this.inbox, request.data.id, `${JSON.stringify(request.data)}\n`);

    const deadline = Date.now() + this.acknowledgmentTimeoutMs;
    while (Date.now() < deadline) {
      if (
        await readAcknowledgment(acknowledgment, request.data.id, this.acknowledgmentUid) === "persisted"
      ) {
        await unlink(acknowledgment).catch(() => { throw stateInvalid(); });
        await syncDirectory(this.statusDirectory);
        return;
      }
      await delay(this.pollIntervalMs);
    }
    throw unavailable();
  }
}
