import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { ApiError } from "@/server/http/api-error";

import { readBoundedUtf8 } from "./bounded-file";
import {
  acquireKernelLock,
  KernelLockBusyError,
  type KernelLockEndpoint,
} from "./kernel-lock";
import { maintenanceUuidSchema, portableBackupIdSchema } from "./types";

const tokenPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  adminId: maintenanceUuidSchema,
  backupId: portableBackupIdSchema,
  nonce: z.uuid(),
  exp: z.number().int().safe(),
});
const markerSchema = z.strictObject({
  schemaVersion: z.literal(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  exp: z.number().int().safe(),
});
const markerNamePattern = /^([0-9a-f]{64})\.used$/;
const markerLimit = 256;

export interface DownloadTokenConfiguration {
  secret: string;
  markerDirectory: string;
  lockEndpoint?: KernelLockEndpoint;
}

export interface IssueDownloadTokenInput {
  adminId: string;
  backupId: string;
  now?: number;
  nonce?: string;
}

function unavailable(): ApiError {
  return new ApiError(404, "BACKUP_NOT_FOUND", "备份不存在或下载链接已失效");
}

function invalidState(): ApiError {
  return new ApiError(500, "DOWNLOAD_TOKEN_STATE_INVALID", "下载令牌状态暂时不可用");
}

function storeFull(): ApiError {
  return new ApiError(503, "DOWNLOAD_TOKEN_STORE_FULL", "下载令牌状态暂时繁忙");
}

function requireConfiguration(configuration: DownloadTokenConfiguration): void {
  if (configuration.secret.length < 32 || !path.isAbsolute(configuration.markerDirectory)) {
    throw invalidState();
  }
}

function signature(encoded: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(encoded).digest();
}

export function issueDownloadToken(
  input: IssueDownloadTokenInput,
  configuration: DownloadTokenConfiguration,
): string {
  requireConfiguration(configuration);
  const payload = tokenPayloadSchema.safeParse({
    schemaVersion: 1,
    adminId: input.adminId,
    backupId: input.backupId,
    nonce: input.nonce ?? randomUUID(),
    exp: (input.now ?? Math.floor(Date.now() / 1_000)) + 60,
  });
  if (!payload.success) throw unavailable();
  const encoded = Buffer.from(JSON.stringify(payload.data), "utf8").toString("base64url");
  return `${encoded}.${signature(encoded, configuration.secret).toString("base64url")}`;
}

function verifyToken(
  token: string,
  adminId: string,
  backupId: string,
  now: number,
  secret: string,
): z.infer<typeof tokenPayloadSchema> {
  if (token.length > 4_096) throw unavailable();
  if (!maintenanceUuidSchema.safeParse(adminId).success || !portableBackupIdSchema.safeParse(backupId).success) {
    throw unavailable();
  }
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!match) throw unavailable();
  const [, encoded, suppliedText] = match;
  const expected = signature(encoded, secret);
  const supplied = Buffer.from(suppliedText, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw unavailable();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw unavailable();
  }
  const payload = tokenPayloadSchema.safeParse(value);
  if (
    !payload.success
    || payload.data.adminId !== adminId
    || payload.data.backupId !== backupId
    || now >= payload.data.exp
  ) throw unavailable();
  return payload.data;
}

async function requireMarkerDirectory(markerDirectory: string): Promise<void> {
  const parent = path.dirname(markerDirectory);
  try {
    const parentInfo = await lstat(parent);
    if (
      !parentInfo.isDirectory()
      || parentInfo.isSymbolicLink()
      || await realpath(parent) !== path.resolve(parent)
    ) throw invalidState();
    await mkdir(markerDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw invalidState();
  }
  try {
    const info = await lstat(markerDirectory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw invalidState();
    if (await realpath(markerDirectory) !== path.resolve(markerDirectory)) throw invalidState();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidState();
  }
}

async function acquireStoreLock(configuration: DownloadTokenConfiguration): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await acquireKernelLock(
        configuration.markerDirectory,
        "download-token-store",
        configuration.lockEndpoint,
      );
    } catch (error) {
      if (!(error instanceof KernelLockBusyError)) throw invalidState();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw storeFull();
}

interface ValidatedMarker {
  path: string;
  digest: string;
  exp: number;
  dev: number | bigint;
  ino: number | bigint;
}

async function readMarker(markerDirectory: string, name: string): Promise<ValidatedMarker> {
  const match = markerNamePattern.exec(name);
  if (!match) throw invalidState();
  const markerPath = path.join(markerDirectory, name);
  let handle;
  try {
    const before = await lstat(markerPath);
    if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600) throw invalidState();
    handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw invalidState();
    const parsed = markerSchema.safeParse(JSON.parse(await readBoundedUtf8(handle, 1_024)));
    if (!parsed.success || parsed.data.digest !== match[1]) throw invalidState();
    return {
      path: markerPath,
      digest: parsed.data.digest,
      exp: parsed.data.exp,
      dev: opened.dev,
      ino: opened.ino,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidState();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function pruneMarker(marker: ValidatedMarker): Promise<void> {
  try {
    const current = await lstat(marker.path);
    if (
      !current.isFile()
      || current.isSymbolicLink()
      || current.dev !== marker.dev
      || current.ino !== marker.ino
    ) throw invalidState();
    await unlink(marker.path);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidState();
  }
}

async function syncMarkerDirectory(markerDirectory: string): Promise<void> {
  let directoryHandle;
  try {
    directoryHandle = await open(markerDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await directoryHandle.stat();
    if (!info.isDirectory()) throw invalidState();
    await directoryHandle.sync();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidState();
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
}

export async function consumeDownloadToken(
  token: string,
  adminId: string,
  backupId: string,
  now: number,
  configuration: DownloadTokenConfiguration,
): Promise<void> {
  requireConfiguration(configuration);
  const payload = verifyToken(token, adminId, backupId, now, configuration.secret);
  await requireMarkerDirectory(configuration.markerDirectory);
  const digest = createHash("sha256").update(token).digest("hex");
  const release = await acquireStoreLock(configuration);
  try {
    const names = await readdir(configuration.markerDirectory).catch(() => { throw invalidState(); });
    const markers: ValidatedMarker[] = [];
    for (const name of names.sort()) markers.push(await readMarker(configuration.markerDirectory, name));
    if (markers.some((marker) => marker.digest === digest)) throw unavailable();

    const expired = markers.filter((marker) => marker.exp <= now);
    for (const marker of expired) await pruneMarker(marker);
    if (markers.length - expired.length >= markerLimit) throw storeFull();

    const markerPath = path.join(configuration.markerDirectory, `${digest}.used`);
    let handle;
    try {
      handle = await open(
        markerPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, digest, exp: payload.exp })}\n`);
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw unavailable();
      throw invalidState();
    } finally {
      await handle?.close().catch(() => undefined);
    }
    await syncMarkerDirectory(configuration.markerDirectory);
  } finally {
    await release();
  }
}

export class DownloadTokenService {
  constructor(private readonly configuration: DownloadTokenConfiguration) {
    requireConfiguration(configuration);
  }

  issue(input: IssueDownloadTokenInput): string {
    return issueDownloadToken(input, this.configuration);
  }

  consume(token: string, adminId: string, backupId: string, now = Math.floor(Date.now() / 1_000)) {
    return consumeDownloadToken(token, adminId, backupId, now, this.configuration);
  }
}
